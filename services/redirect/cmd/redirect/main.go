// Command redirect serves GET /{slug}: the hot path of the URL shortener.
//
// On a cache hit a request costs one Redis round trip (rate limit, lookup,
// expiry and click limit in a single Lua script) and no SQL. The click is
// handed to a background emitter, so analytics never adds latency.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/redis/go-redis/v9"

	"github.com/bastian-red/url-shortener/services/redirect/internal/clicks"
	"github.com/bastian-red/url-shortener/services/redirect/internal/config"
	"github.com/bastian-red/url-shortener/services/redirect/internal/linkcache"
	"github.com/bastian-red/url-shortener/services/redirect/internal/server"
	"github.com/bastian-red/url-shortener/services/redirect/internal/store"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(healthcheck())
	}
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(log); err != nil {
		log.Error("redirect: fatal", "err", err)
		os.Exit(1)
	}
}

// healthcheck is the container's HEALTHCHECK: the runtime image is distroless,
// with no shell or curl, so the binary asks its own /health. 0 only on a 200,
// which /health answers only when Redis and Postgres both respond.
func healthcheck() int {
	port := os.Getenv("REDIRECT_PORT")
	if port == "" {
		port = "8080"
	}
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/health")
	if err != nil {
		return 1
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func run(log *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("configuration: %w", err)
	}

	ropts, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		return fmt.Errorf("REDIS_URL: %w", err)
	}
	// Short timeouts: a Redis that takes longer than this is treated as down and
	// the request takes the degraded Postgres path instead of hanging.
	ropts.DialTimeout = 500 * time.Millisecond
	ropts.ReadTimeout = 250 * time.Millisecond
	ropts.WriteTimeout = 250 * time.Millisecond
	ropts.PoolSize = 64
	ropts.MinIdleConns = 8
	rdb := redis.NewClient(ropts)
	defer rdb.Close()

	pcfg, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("DATABASE_URL: %w", err)
	}
	pcfg.MaxConns = 8 // misses only; a hit never touches Postgres
	pool, err := pgxpool.NewWithConfig(context.Background(), pcfg)
	if err != nil {
		return fmt.Errorf("postgres pool: %w", err)
	}
	defer pool.Close()

	var metrics *server.Metrics
	var emitter *clicks.Emitter
	metrics = server.NewMetrics(func() int { return emitter.QueueDepth() })
	emitter = clicks.NewEmitter(rdb, cfg.StreamMaxLen, metrics, log, clicks.Options{})

	handler := server.New(server.Options{
		Cache:            linkcache.New(rdb, linkcache.Limit{PerMinute: cfg.RatePerMinute, Burst: cfg.Burst}),
		Store:            store.New(pool),
		Emitter:          emitter,
		Metrics:          metrics,
		Log:              log,
		AppBaseURL:       cfg.AppBaseURL,
		Version:          cfg.Version,
		TrustProxyHops:   cfg.TrustProxyHops,
		LinkCacheTTL:     cfg.LinkCacheTTL,
		NegativeCacheTTL: cfg.NegativeCacheTTL,
	})

	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}

	errc := make(chan error, 1)
	go func() {
		log.Info("redirect: listening", "port", cfg.Port, "version", cfg.Version, "trust_proxy_hops", cfg.TrustProxyHops)
		errc <- srv.ListenAndServe()
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case sig := <-stop:
		log.Info("redirect: shutting down", "signal", sig.String())
	}

	// Stop taking requests, then flush the clicks already accepted: a deploy
	// must not drop the last second of traffic on the floor.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Error("redirect: http shutdown", "err", err)
	}
	emitter.Close(ctx)
	return nil
}
