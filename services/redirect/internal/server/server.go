// Package server is the HTTP surface: GET/HEAD /{slug}, /health, /metrics.
package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"golang.org/x/sync/singleflight"

	"github.com/bastian-red/url-shortener/services/redirect/internal/clicks"
	"github.com/bastian-red/url-shortener/services/redirect/internal/clientip"
	"github.com/bastian-red/url-shortener/services/redirect/internal/health"
	"github.com/bastian-red/url-shortener/services/redirect/internal/linkcache"
	"github.com/bastian-red/url-shortener/services/redirect/internal/pages"
)

// slugPattern is SLUG_PATTERN from packages/shared. A path that cannot be a
// slug is answered 404 without touching Redis, so a scanner probing
// `/wp-login.php` costs nothing.
var slugPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$`)

// Cache is the slice of linkcache.Cache the handler uses.
type Cache interface {
	Resolve(ctx context.Context, slug, ip string, now time.Time, mode linkcache.Mode) (linkcache.Result, error)
	Populate(ctx context.Context, slug string, r linkcache.Record, ttl time.Duration) (bool, error)
	Ping(ctx context.Context) error
}

// Store is the slice of store.Store the handler uses.
type Store interface {
	Load(ctx context.Context, slug string) (linkcache.Record, error)
	Ping(ctx context.Context) error
}

// Emitter is the slice of clicks.Emitter the handler uses.
type Emitter interface {
	Emit(clicks.Event) bool
}

// Options configure a Server.
type Options struct {
	Cache            Cache
	Store            Store
	Emitter          Emitter
	Metrics          *Metrics
	Log              *slog.Logger
	AppBaseURL       string
	Version          string
	TrustProxyHops   int
	LinkCacheTTL     time.Duration
	NegativeCacheTTL time.Duration
	// Now is the clock; tests move it.
	Now func() time.Time
}

// Server is an http.Handler.
type Server struct {
	o       Options
	mux     *http.ServeMux
	loads   singleflight.Group
	started time.Time
}

func New(o Options) *Server {
	if o.Now == nil {
		o.Now = time.Now
	}
	s := &Server{o: o, mux: http.NewServeMux(), started: o.Now()}
	s.mux.HandleFunc("GET /health", s.health)
	s.mux.Handle("GET /metrics", promhttp.HandlerFor(o.Metrics.Registry, promhttp.HandlerOpts{}))
	s.mux.HandleFunc("GET /robots.txt", robots)
	s.mux.HandleFunc("GET /{$}", s.home)
	// A GET pattern also matches HEAD in net/http, so this is both. The handler
	// tells them apart: HEAD neither counts nor emits.
	s.mux.HandleFunc("GET /{slug}", s.redirect)
	s.mux.HandleFunc("/", s.notFound)
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func (s *Server) redirect(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	slug := r.PathValue("slug")
	outcome := s.serveRedirect(w, r, slug)
	s.o.Metrics.duration.WithLabelValues(outcome).Observe(time.Since(start).Seconds())
}

// serveRedirect returns the outcome label for the latency histogram.
func (s *Server) serveRedirect(w http.ResponseWriter, r *http.Request, slug string) string {
	if !slugPattern.MatchString(slug) {
		pages.Write(w, pages.NotFound, "", s.o.AppBaseURL, 0)
		return "bad_slug"
	}
	ctx := r.Context()
	ip := clientip.From(r, s.o.TrustProxyHops)
	now := s.o.Now()
	mode := linkcache.Visit
	if r.Method == http.MethodHead {
		mode.Count = false
	}

	res, err := s.o.Cache.Resolve(ctx, slug, ip, now, mode)
	if err != nil {
		return s.degraded(w, r, slug, err)
	}
	if res.Outcome == linkcache.Miss {
		s.o.Metrics.misses.Inc()
		if err := s.load(ctx, slug); err != nil {
			s.o.Log.Error("cache miss: load failed", "slug", slug, "err", err)
			pages.Write(w, pages.Unavailable, "", s.o.AppBaseURL, 0)
			return "error"
		}
		// The first call already charged the rate limit for this request.
		mode.RateLimit = false
		if res, err = s.o.Cache.Resolve(ctx, slug, ip, now, mode); err != nil {
			return s.degraded(w, r, slug, err)
		}
		if res.Outcome == linkcache.Miss {
			// Populated and gone again within microseconds: only an eviction
			// storm does this. Refuse rather than loop.
			pages.Write(w, pages.Unavailable, "", s.o.AppBaseURL, 0)
			return "error"
		}
	}

	switch res.Outcome {
	case linkcache.OK:
		s.found(w, res.URL)
		if r.Method == http.MethodGet {
			// After the headers are set but before the handler returns, which is
			// when net/http flushes. Emit is a non-blocking channel send, so the
			// visitor does not wait on it either way.
			s.o.Emitter.Emit(clicks.Event{
				LinkID: res.LinkID, Slug: slug, At: now, IP: ip,
				UA: r.UserAgent(), Referer: r.Referer(), Language: r.Header.Get("Accept-Language"),
			})
		}
	case linkcache.NotFound:
		pages.Write(w, pages.NotFound, slug, s.o.AppBaseURL, 0)
	case linkcache.Expired:
		pages.Write(w, pages.Expired, slug, s.o.AppBaseURL, 0)
	case linkcache.LimitReached:
		pages.Write(w, pages.LimitReached, slug, s.o.AppBaseURL, 0)
	case linkcache.Disabled:
		pages.Write(w, pages.Disabled, slug, s.o.AppBaseURL, 0)
	case linkcache.RateLimited:
		pages.Write(w, pages.TooManyRequests, "", s.o.AppBaseURL, int(math.Ceil(res.RetryAfter.Seconds())))
	}
	return res.Outcome.String()
}

// found writes the redirect.
//
// 302, not 301. A 301 is cacheable forever by default, so the browser would
// skip this service on every later visit: the click would never be counted,
// and editing or disabling the link would never reach anyone who had visited it
// once. `private, max-age=0` keeps shared caches out as well.
func (s *Server) found(w http.ResponseWriter, url string) {
	h := w.Header()
	h.Set("Location", url)
	h.Set("Cache-Control", "private, max-age=0")
	h.Set("X-Robots-Tag", "noindex")
	h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
	w.WriteHeader(http.StatusFound)
}

// load fills the cache from Postgres. singleflight collapses a burst of misses
// for one slug (a link going viral the moment it is shared) into one query.
func (s *Server) load(ctx context.Context, slug string) error {
	_, err, _ := s.loads.Do(slug, func() (any, error) {
		// Detached from the first caller's request: if that visitor closes the
		// tab, the load the others are waiting on must still finish.
		lctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		rec, err := s.o.Store.Load(lctx, slug)
		if err != nil {
			return nil, err
		}
		ttl := s.o.LinkCacheTTL
		if !rec.Found {
			ttl = s.o.NegativeCacheTTL
		}
		_, err = s.o.Cache.Populate(lctx, slug, rec, ttl)
		return nil, err
	})
	return err
}

// degraded answers when Redis itself failed. A link with no click limit can
// still be served from Postgres: slower, unrated and uncounted, but the visitor
// gets where they were going. A link WITH a click limit cannot, because the
// counter that enforces it is in Redis, and serving it would break the
// promise the limit makes. Neither case pretends the link does not exist.
func (s *Server) degraded(w http.ResponseWriter, r *http.Request, slug string, cause error) string {
	s.o.Log.Error("redis resolve failed; trying postgres", "slug", slug, "err", cause)
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	rec, err := s.o.Store.Load(ctx, slug)
	switch {
	case err != nil:
		pages.Write(w, pages.Unavailable, "", s.o.AppBaseURL, 0)
		return "error"
	case !rec.Found:
		pages.Write(w, pages.NotFound, slug, s.o.AppBaseURL, 0)
		return "not_found"
	case rec.Disabled:
		pages.Write(w, pages.Disabled, slug, s.o.AppBaseURL, 0)
		return "disabled"
	case !rec.ExpiresAt.IsZero() && !rec.ExpiresAt.After(s.o.Now()):
		pages.Write(w, pages.Expired, slug, s.o.AppBaseURL, 0)
		return "expired"
	case rec.MaxClicks > 0:
		pages.Write(w, pages.Unavailable, "", s.o.AppBaseURL, 0)
		return "error"
	}
	s.o.Metrics.degraded.Inc()
	s.found(w, rec.URL)
	return "degraded"
}

func (s *Server) home(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, s.o.AppBaseURL, http.StatusFound)
}

func (s *Server) notFound(w http.ResponseWriter, _ *http.Request) {
	pages.Write(w, pages.NotFound, "", s.o.AppBaseURL, 0)
}

func robots(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("User-agent: *\nDisallow: /\n"))
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	report := health.Run(r.Context(), "redirect", s.o.Version, s.started, time.Second, []health.Check{
		{Name: "redis", Probe: s.o.Cache.Ping},
		{Name: "postgres", Probe: s.o.Store.Ping},
	})
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if report.Status != "ok" {
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	_ = json.NewEncoder(w).Encode(report)
}
