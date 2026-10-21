package config

import (
	"strings"
	"testing"
	"time"
)

func fake(values map[string]string) lookup {
	return func(name string) (string, bool) {
		v, ok := values[name]
		return v, ok
	}
}

var minimal = map[string]string{
	"REDIS_URL":    "redis://localhost:6388",
	"DATABASE_URL": "postgresql://links:links@localhost:5442/links?schema=public",
}

func TestDefaults(t *testing.T) {
	c, err := load(fake(minimal))
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 8080 || c.TrustProxyHops != 0 || c.RatePerMinute != 600 || c.Burst != 60 {
		t.Fatalf("unexpected defaults: %+v", c)
	}
	if c.LinkCacheTTL != 24*time.Hour || c.NegativeCacheTTL != time.Minute {
		t.Fatalf("unexpected TTLs: %+v", c)
	}
}

func TestEmptyValuesMeanDefault(t *testing.T) {
	// .env.example ships some names blank; blank must not parse as 0.
	values := map[string]string{"REDIRECT_PORT": "", "RATE_LIMIT_REDIRECT": "  "}
	for k, v := range minimal {
		values[k] = v
	}
	c, err := load(fake(values))
	if err != nil || c.Port != 8080 || c.RatePerMinute != 600 {
		t.Fatalf("blank values: %+v %v", c, err)
	}
}

func TestEveryProblemIsReportedAtOnce(t *testing.T) {
	_, err := load(fake(map[string]string{"REDIRECT_PORT": "abc", "TRUST_PROXY_HOPS": "9"}))
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"REDIRECT_PORT", "TRUST_PROXY_HOPS", "REDIS_URL", "DATABASE_URL"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %s: %v", want, err)
		}
	}
}

func TestPgxDSNDropsPrismaSchemaParam(t *testing.T) {
	cases := map[string]string{
		"postgresql://u:p@h:5442/db?schema=public":           "postgresql://u:p@h:5442/db",
		"postgresql://u:p@h:5442/db?schema=tenant&sslmode=x": "postgresql://u:p@h:5442/db?search_path=tenant&sslmode=x",
		"postgres://u:p@h/db":                                "postgres://u:p@h/db",
	}
	for in, want := range cases {
		got, err := PgxDSN(in)
		if err != nil || got != want {
			t.Errorf("PgxDSN(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	if _, err := PgxDSN("mysql://x"); err == nil {
		t.Error("accepted a non-postgres URL")
	}
}
