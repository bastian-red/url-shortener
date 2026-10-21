// Package config reads the redirect service's environment once, at boot.
//
// Every name read here is also declared in the repo's turbo.json; the
// environment contract (scripts/env-contract.mjs) scans this file for the
// envOr / envInt / envDuration calls below and fails the commit if one is
// missing there. Turbo runs in strict env mode, so a name it does not declare
// never reaches this process.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the validated configuration. Zero values are never "use a default":
// Load fills every field or returns an error.
type Config struct {
	Port        int
	RedisURL    string
	DatabaseURL string
	// AppBaseURL is where "/" and the error pages send a visitor.
	AppBaseURL string
	Version    string

	// TrustProxyHops is how many reverse proxies sit in front of this process.
	// 0 ignores X-Forwarded-For entirely, which is the only safe default: with
	// no proxy, that header is whatever the client typed.
	TrustProxyHops int

	// Per client address. GCRA: RatePerMinute sustained, Burst on top.
	RatePerMinute int
	Burst         int

	LinkCacheTTL     time.Duration
	NegativeCacheTTL time.Duration
	// StreamMaxLen bounds the clicks stream (XADD MAXLEN ~). If the worker is
	// down long enough to reach it, the oldest unprocessed clicks are trimmed:
	// memory stays bounded and the redirect path never blocks, at the cost of
	// analytics for that window. /health on the API reports the stream length.
	StreamMaxLen int64
}

// Load reads the process environment.
func Load() (Config, error) { return load(os.LookupEnv) }

type lookup func(string) (string, bool)

func load(env lookup) (Config, error) {
	var errs []error
	c := Config{
		Port:             envInt(env, "REDIRECT_PORT", 8080, &errs),
		RedisURL:         envOr(env, "REDIS_URL", ""),
		AppBaseURL:       strings.TrimRight(envOr(env, "APP_BASE_URL", "http://localhost:3000"), "/"),
		Version:          envOr(env, "APP_VERSION", "dev"),
		TrustProxyHops:   envInt(env, "TRUST_PROXY_HOPS", 0, &errs),
		RatePerMinute:    envInt(env, "RATE_LIMIT_REDIRECT", 600, &errs),
		Burst:            envInt(env, "RATE_LIMIT_REDIRECT_BURST", 60, &errs),
		LinkCacheTTL:     envDuration(env, "LINK_CACHE_TTL_SECONDS", 24*time.Hour, &errs),
		NegativeCacheTTL: envDuration(env, "NEGATIVE_CACHE_SECONDS", time.Minute, &errs),
		StreamMaxLen:     int64(envInt(env, "STREAM_MAXLEN", 1_000_000, &errs)),
	}

	dsn, err := PgxDSN(envOr(env, "DATABASE_URL", ""))
	if err != nil {
		errs = append(errs, err)
	}
	c.DatabaseURL = dsn

	if c.RedisURL == "" {
		errs = append(errs, errors.New("REDIS_URL is required"))
	}
	if c.Port < 1 || c.Port > 65535 {
		errs = append(errs, fmt.Errorf("REDIRECT_PORT %d is not a port", c.Port))
	}
	if c.TrustProxyHops < 0 || c.TrustProxyHops > 5 {
		errs = append(errs, fmt.Errorf("TRUST_PROXY_HOPS %d must be 0..5", c.TrustProxyHops))
	}
	if c.RatePerMinute < 1 || c.Burst < 1 {
		errs = append(errs, errors.New("RATE_LIMIT_REDIRECT and RATE_LIMIT_REDIRECT_BURST must be positive"))
	}
	if c.StreamMaxLen < 1000 {
		errs = append(errs, fmt.Errorf("STREAM_MAXLEN %d is below 1000", c.StreamMaxLen))
	}
	return c, errors.Join(errs...)
}

// PgxDSN turns the Prisma connection string the rest of the repo uses into one
// pgx accepts.
//
// Prisma's URL carries `?schema=public`. pgx forwards every query parameter it
// does not recognise to the server as a run-time setting, and Postgres refuses
// to start a session with an unknown setting called "schema". So the parameter
// is removed, and a non-default schema becomes the search_path it means.
func PgxDSN(raw string) (string, error) {
	if raw == "" {
		return "", errors.New("DATABASE_URL is required")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return "", errors.New("DATABASE_URL must be a postgres:// URL")
	}
	q := u.Query()
	schema := q.Get("schema")
	q.Del("schema")
	if schema != "" && schema != "public" {
		q.Set("search_path", schema)
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func envOr(env lookup, name, fallback string) string {
	if v, ok := env(name); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return fallback
}

func envInt(env lookup, name string, fallback int, errs *[]error) int {
	raw := envOr(env, name, "")
	if raw == "" {
		return fallback
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		*errs = append(*errs, fmt.Errorf("%s=%q is not an integer", name, raw))
		return fallback
	}
	return n
}

func envDuration(env lookup, name string, fallback time.Duration, errs *[]error) time.Duration {
	seconds := envInt(env, name, -1, errs)
	if seconds == -1 {
		return fallback
	}
	if seconds < 1 {
		*errs = append(*errs, fmt.Errorf("%s must be at least 1 second", name))
		return fallback
	}
	return time.Duration(seconds) * time.Second
}
