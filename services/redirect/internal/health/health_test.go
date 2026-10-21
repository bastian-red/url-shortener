package health

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRun(t *testing.T) {
	r := Run(context.Background(), "redirect", "1.0.0", time.Now().Add(-90*time.Second), 50*time.Millisecond, []Check{
		{"redis", func(context.Context) error { return nil }},
		{"postgres", func(context.Context) error { return errors.New("connection refused") }},
		{"slow", func(ctx context.Context) error { <-ctx.Done(); return ctx.Err() }},
	})
	if r.Status != "degraded" || r.Service != "redirect" || r.UptimeSeconds != 90 {
		t.Fatalf("report: %+v", r)
	}
	if r.Checks[0].Status != "ok" || r.Checks[0].Detail != nil {
		t.Fatalf("redis: %+v", r.Checks[0])
	}
	if r.Checks[1].Status != "fail" || *r.Checks[1].Detail != "connection refused" {
		t.Fatalf("postgres: %+v", r.Checks[1])
	}
	if r.Checks[2].Status != "fail" || *r.Checks[2].Detail != "timeout after 50ms" {
		t.Fatalf("slow: %+v", r.Checks[2])
	}
}

func TestAllOK(t *testing.T) {
	r := Run(context.Background(), "redirect", "x", time.Now(), time.Second, []Check{{"a", func(context.Context) error { return nil }}})
	if r.Status != "ok" {
		t.Fatal(r.Status)
	}
}
