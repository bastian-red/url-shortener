package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/bastian-red/url-shortener/services/redirect/internal/clicks"
	"github.com/bastian-red/url-shortener/services/redirect/internal/linkcache"
)

// --- fakes: the handler's logic, without Redis or Postgres ------------------

type fakeCache struct {
	mu        sync.Mutex
	records   map[string]linkcache.Record
	err       error
	limited   bool
	calls     []linkcache.Mode
	populates int
}

func (c *fakeCache) Resolve(_ context.Context, slug, _ string, now time.Time, mode linkcache.Mode) (linkcache.Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, mode)
	if c.err != nil {
		return linkcache.Result{}, c.err
	}
	if c.limited && mode.RateLimit {
		return linkcache.Result{Outcome: linkcache.RateLimited, RetryAfter: 1200 * time.Millisecond}, nil
	}
	rec, ok := c.records[slug]
	switch {
	case !ok:
		return linkcache.Result{Outcome: linkcache.Miss}, nil
	case !rec.Found:
		return linkcache.Result{Outcome: linkcache.NotFound}, nil
	case rec.Disabled:
		return linkcache.Result{Outcome: linkcache.Disabled}, nil
	case !rec.ExpiresAt.IsZero() && !rec.ExpiresAt.After(now):
		return linkcache.Result{Outcome: linkcache.Expired}, nil
	}
	return linkcache.Result{Outcome: linkcache.OK, LinkID: rec.ID, URL: rec.URL}, nil
}

func (c *fakeCache) Populate(_ context.Context, slug string, r linkcache.Record, _ time.Duration) (bool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.populates++
	c.records[slug] = r
	return true, nil
}

func (c *fakeCache) Ping(context.Context) error { return c.err }

type fakeStore struct {
	records map[string]linkcache.Record
	loads   atomic.Int64
	delay   time.Duration
	err     error
}

func (s *fakeStore) Load(_ context.Context, slug string) (linkcache.Record, error) {
	s.loads.Add(1)
	time.Sleep(s.delay)
	if s.err != nil {
		return linkcache.Record{}, s.err
	}
	if r, ok := s.records[slug]; ok {
		return r, nil
	}
	return linkcache.Record{Found: false}, nil
}

func (s *fakeStore) Ping(context.Context) error { return s.err }

type fakeEmitter struct {
	mu     sync.Mutex
	events []clicks.Event
}

func (e *fakeEmitter) Emit(ev clicks.Event) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.events = append(e.events, ev)
	return true
}

var t0 = time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)

func newTestServer(cache *fakeCache, store *fakeStore, em *fakeEmitter) *Server {
	return New(Options{
		Cache: cache, Store: store, Emitter: em, Metrics: NewMetrics(func() int { return 0 }),
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)), AppBaseURL: "http://app.test",
		Version: "test", TrustProxyHops: 1, LinkCacheTTL: time.Hour, NegativeCacheTTL: time.Minute,
		Now: func() time.Time { return t0 },
	})
}

var launch = linkcache.Record{Found: true, ID: "link1", URL: "https://example.com/launch"}

func get(s http.Handler, method, path string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, nil)
	r.RemoteAddr = "10.0.0.1:5000"
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	s.ServeHTTP(rec, r)
	return rec
}

// --- tests -----------------------------------------------------------------

func TestHitRedirects302WithNoCacheAndEmitsOneClick(t *testing.T) {
	cache := &fakeCache{records: map[string]linkcache.Record{"launch": launch}}
	em := &fakeEmitter{}
	s := newTestServer(cache, &fakeStore{}, em)

	rec := get(s, "GET", "/launch", map[string]string{
		"X-Forwarded-For": "81.2.69.160", "User-Agent": "UA/1", "Referer": "https://t.co/x", "Accept-Language": "en-GB",
	})
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != launch.URL {
		t.Fatalf("got %d %q", rec.Code, rec.Header().Get("Location"))
	}
	if rec.Header().Get("Cache-Control") != "private, max-age=0" {
		t.Fatalf("Cache-Control = %q: a cacheable redirect would stop counting clicks", rec.Header().Get("Cache-Control"))
	}
	if len(em.events) != 1 {
		t.Fatalf("emitted %d events", len(em.events))
	}
	ev := em.events[0]
	if ev.IP != "81.2.69.160" || ev.LinkID != "link1" || ev.Slug != "launch" || ev.UA != "UA/1" ||
		ev.Referer != "https://t.co/x" || ev.Language != "en-GB" || !ev.At.Equal(t0) {
		t.Fatalf("event: %+v", ev)
	}
}

func TestHeadRedirectsWithoutCountingOrEmitting(t *testing.T) {
	cache := &fakeCache{records: map[string]linkcache.Record{"launch": launch}}
	em := &fakeEmitter{}
	s := newTestServer(cache, &fakeStore{}, em)
	rec := get(s, "HEAD", "/launch", nil)
	if rec.Code != http.StatusFound || len(em.events) != 0 {
		t.Fatalf("HEAD: %d, %d events", rec.Code, len(em.events))
	}
	if cache.calls[0].Count {
		t.Fatal("HEAD counted against the click limit")
	}
}

func TestAPathThatCannotBeASlugNeverReachesRedis(t *testing.T) {
	cache := &fakeCache{records: map[string]linkcache.Record{}}
	s := newTestServer(cache, &fakeStore{}, &fakeEmitter{})
	for _, path := range []string{"/wp-login.php", "/ab", "/-x1", "/a%2Fb"} {
		if rec := get(s, "GET", path, nil); rec.Code != http.StatusNotFound {
			t.Errorf("%s: %d", path, rec.Code)
		}
	}
	if len(cache.calls) != 0 {
		t.Fatalf("%d Redis calls for impossible slugs", len(cache.calls))
	}
}

func TestMissLoadsOncePopulatesAndRetriesWithoutChargingTheRateLimitTwice(t *testing.T) {
	cache := &fakeCache{records: map[string]linkcache.Record{}}
	store := &fakeStore{records: map[string]linkcache.Record{"launch": launch}}
	s := newTestServer(cache, store, &fakeEmitter{})

	if rec := get(s, "GET", "/launch", nil); rec.Code != http.StatusFound {
		t.Fatalf("got %d", rec.Code)
	}
	if store.loads.Load() != 1 || cache.populates != 1 {
		t.Fatalf("loads %d populates %d", store.loads.Load(), cache.populates)
	}
	if len(cache.calls) != 2 || !cache.calls[0].RateLimit || cache.calls[1].RateLimit || !cache.calls[1].Count {
		t.Fatalf("modes: %+v", cache.calls)
	}
}

func TestConcurrentMissesCollapseIntoOneQuery(t *testing.T) {
	cache := &fakeCache{records: map[string]linkcache.Record{}}
	store := &fakeStore{records: map[string]linkcache.Record{"viral": launch}, delay: 50 * time.Millisecond}
	s := newTestServer(cache, store, &fakeEmitter{})

	var wg sync.WaitGroup
	for range 50 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if rec := get(s, "GET", "/viral", nil); rec.Code != http.StatusFound {
				t.Errorf("got %d", rec.Code)
			}
		}()
	}
	wg.Wait()
	if n := store.loads.Load(); n != 1 {
		t.Fatalf("Postgres was queried %d times for one slug; singleflight should make it 1", n)
	}
}

func TestUnknownSlugIsNegativelyCached(t *testing.T) {
	cache := &fakeCache{records: map[string]linkcache.Record{}}
	store := &fakeStore{records: map[string]linkcache.Record{}}
	s := newTestServer(cache, store, &fakeEmitter{})
	for range 3 {
		if rec := get(s, "GET", "/nope123", nil); rec.Code != http.StatusNotFound {
			t.Fatalf("got %d", rec.Code)
		}
	}
	if store.loads.Load() != 1 {
		t.Fatalf("a missing slug hit Postgres %d times", store.loads.Load())
	}
}

func TestOutcomesMapToPages(t *testing.T) {
	cache := &fakeCache{records: map[string]linkcache.Record{
		"off": {Found: true, ID: "a", URL: "https://e.x", Disabled: true},
		"old": {Found: true, ID: "b", URL: "https://e.x", ExpiresAt: t0},
	}}
	s := newTestServer(cache, &fakeStore{}, &fakeEmitter{})
	if rec := get(s, "GET", "/off", nil); rec.Code != http.StatusGone || !strings.Contains(rec.Body.String(), "Turned off") {
		t.Fatalf("disabled: %d", rec.Code)
	}
	if rec := get(s, "GET", "/old", nil); rec.Code != http.StatusGone || !strings.Contains(rec.Body.String(), "Expired") {
		t.Fatalf("expired: %d", rec.Code)
	}
}

func TestRateLimitedAnswers429WithRetryAfterRoundedUp(t *testing.T) {
	cache := &fakeCache{records: map[string]linkcache.Record{"launch": launch}, limited: true}
	s := newTestServer(cache, &fakeStore{}, &fakeEmitter{})
	rec := get(s, "GET", "/launch", nil)
	if rec.Code != http.StatusTooManyRequests || rec.Header().Get("Retry-After") != "2" {
		t.Fatalf("got %d Retry-After %q", rec.Code, rec.Header().Get("Retry-After"))
	}
}

func TestRedisDownServesUnlimitedLinksFromPostgresAndRefusesLimitedOnes(t *testing.T) {
	cache := &fakeCache{records: map[string]linkcache.Record{}, err: errors.New("connection refused")}
	store := &fakeStore{records: map[string]linkcache.Record{
		"launch": launch,
		"once":   {Found: true, ID: "c", URL: "https://e.x/once", MaxClicks: 1},
	}}
	em := &fakeEmitter{}
	s := newTestServer(cache, store, em)

	if rec := get(s, "GET", "/launch", nil); rec.Code != http.StatusFound || rec.Header().Get("Location") != launch.URL {
		t.Fatalf("unlimited link with Redis down: %d", rec.Code)
	}
	if rec := get(s, "GET", "/once", nil); rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("limited link with Redis down: %d; serving it would break the limit", rec.Code)
	}
	if rec := get(s, "GET", "/missing1", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("missing link with Redis down: %d", rec.Code)
	}
	if len(em.events) != 0 {
		t.Fatal("emitted a click while Redis is down")
	}
}

func TestHealthIs503WhenADependencyFails(t *testing.T) {
	s := newTestServer(&fakeCache{records: map[string]linkcache.Record{}}, &fakeStore{err: errors.New("down")}, &fakeEmitter{})
	rec := get(s, "GET", "/health", nil)
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), `"status":"degraded"`) {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
	s = newTestServer(&fakeCache{records: map[string]linkcache.Record{}}, &fakeStore{}, &fakeEmitter{})
	if rec := get(s, "GET", "/health", nil); rec.Code != http.StatusOK {
		t.Fatalf("healthy: %d", rec.Code)
	}
}

func TestMetricsExposeTheRedirectHistogram(t *testing.T) {
	s := newTestServer(&fakeCache{records: map[string]linkcache.Record{"launch": launch}}, &fakeStore{}, &fakeEmitter{})
	get(s, "GET", "/launch", nil)
	body := get(s, "GET", "/metrics", nil).Body.String()
	if !strings.Contains(body, `redirect_duration_seconds_count{outcome="ok"} 1`) {
		t.Fatal("histogram missing from /metrics")
	}
}

func TestRootGoesToTheApp(t *testing.T) {
	s := newTestServer(&fakeCache{records: map[string]linkcache.Record{}}, &fakeStore{}, &fakeEmitter{})
	rec := get(s, "GET", "/", nil)
	if rec.Code != http.StatusFound || rec.Header().Get("Location") != "http://app.test" {
		t.Fatalf("got %d %q", rec.Code, rec.Header().Get("Location"))
	}
}
