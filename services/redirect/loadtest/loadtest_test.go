// Package loadtest measures redirect latency against a running service
// (SPECS outcomes 1 and 2). It is driven by scripts/loadtest.sh, which starts
// the real binary and the click worker, runs this once with the worker
// consuming and once with the worker killed, and compares the two.
//
// Skipped unless LOADTEST_TARGET is set, so `go test ./...` never runs it by
// accident.
package loadtest

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	vegeta "github.com/tsenart/vegeta/v12/lib"
)

// Result is what one phase writes for the script to compare and print.
type Result struct {
	Phase      string         `json:"phase"`
	Rate       int            `json:"rate"`
	DurationS  float64        `json:"durationSeconds"`
	Requests   uint64         `json:"requests"`
	Success    float64        `json:"success"`
	P50Ms      float64        `json:"p50Ms"`
	P95Ms      float64        `json:"p95Ms"`
	P99Ms      float64        `json:"p99Ms"`
	MaxMs      float64        `json:"maxMs"`
	Status302  int            `json:"status302"`
	Warmup     uint64         `json:"warmup"`
	OtherCodes map[string]int `json:"otherCodes"`
}

func envInt(t *testing.T, name string, fallback int) int {
	v := os.Getenv(name)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		t.Fatalf("%s=%q", name, v)
	}
	return n
}

func envFloat(t *testing.T, name string, fallback float64) float64 {
	v := os.Getenv(name)
	if v == "" {
		return fallback
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		t.Fatalf("%s=%q", name, v)
	}
	return f
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func TestRedirectLatency(t *testing.T) {
	target := os.Getenv("LOADTEST_TARGET")
	slug := os.Getenv("LOADTEST_SLUG")
	if target == "" || slug == "" {
		t.Skip("LOADTEST_TARGET and LOADTEST_SLUG not set (run scripts/loadtest.sh)")
	}
	phase := os.Getenv("LOADTEST_PHASE")
	rate := envInt(t, "LOADTEST_RATE", 500)
	duration := time.Duration(envInt(t, "LOADTEST_SECONDS", 10)) * time.Second
	p50Budget := envFloat(t, "LOADTEST_P50_MS", 1.5)
	p99Budget := envFloat(t, "LOADTEST_P99_MS", 5)

	// Spread the traffic over 4,000 client addresses so the test runs at the
	// DOCUMENTED rate limit (600/min, burst 60) rather than lifting it: at 500
	// rps for 10 s each address sends about 1.25 requests. The service must be
	// started with TRUST_PROXY_HOPS=1 for X-Forwarded-For to count, which the
	// script does, because it is playing the part of the proxy.
	addrs := make([]string, 4000)
	for i := range addrs {
		addrs[i] = fmt.Sprintf("100.%d.%d.%d", 64+i/65536%64, i/256%256, i%256)
	}
	targeter := func(tgt *vegeta.Target) error {
		tgt.Method = http.MethodGet
		tgt.URL = target + "/" + slug
		tgt.Header = http.Header{
			"X-Forwarded-For": []string{addrs[rand.IntN(len(addrs))]},
			"User-Agent":      []string{"loadtest/1.0 (vegeta)"},
		}
		return nil
	}

	newAttacker := func() *vegeta.Attacker {
		return vegeta.NewAttacker(vegeta.Redirects(vegeta.NoFollow), vegeta.KeepAlive(true), vegeta.Workers(32))
	}

	// Unmeasured warm-up: opens the keep-alive connections and lets the
	// service's Redis pool and the Go runtime settle, so the first second of
	// connection setup is not reported as the redirect's tail latency.
	var warmup uint64
	// A fresh attacker per run: one that has finished an attack is stopped and
	// sends next to nothing on the next, which a first version of this test
	// measured as a 2-request "phase" that passed every budget.
	for range newAttacker().Attack(targeter, vegeta.Rate{Freq: rate, Per: time.Second}, time.Duration(envInt(t, "LOADTEST_WARMUP_SECONDS", 2))*time.Second, "warmup") {
		warmup++
	}

	var metrics vegeta.Metrics
	codes := map[string]int{}
	for res := range newAttacker().Attack(targeter, vegeta.Rate{Freq: rate, Per: time.Second}, duration, phase) {
		metrics.Add(res)
		codes[strconv.Itoa(int(res.Code))]++
	}
	metrics.Close()

	r := Result{
		Phase: phase, Rate: rate, DurationS: duration.Seconds(), Requests: metrics.Requests,
		Success: metrics.Success, P50Ms: ms(metrics.Latencies.P50), P95Ms: ms(metrics.Latencies.P95),
		P99Ms: ms(metrics.Latencies.P99), MaxMs: ms(metrics.Latencies.Max), Status302: codes["302"], Warmup: warmup, OtherCodes: map[string]int{},
	}
	for code, n := range codes {
		if code != "302" {
			r.OtherCodes[code] = n
		}
	}
	t.Logf("%s: %d requests, p50 %.3f ms, p95 %.3f ms, p99 %.3f ms, max %.3f ms, codes %v",
		phase, r.Requests, r.P50Ms, r.P95Ms, r.P99Ms, r.MaxMs, codes)

	if out := os.Getenv("LOADTEST_OUT"); out != "" {
		raw, _ := json.MarshalIndent(r, "", "  ")
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(out, append(raw, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// The load must actually have been offered: a phase that sent a fraction of
	// its requests would pass any latency budget.
	if want := uint64(float64(rate) * duration.Seconds() * 0.98); r.Requests < want {
		t.Errorf("only %d requests sent, expected at least %d", r.Requests, want)
	}
	// Every request must have been a redirect. A 429 here means the rate limit
	// is mis-keyed; a 5xx means the hot path broke under load.
	if r.Status302 != int(r.Requests) {
		t.Errorf("only %d of %d requests answered 302: %v", r.Status302, r.Requests, codes)
	}
	if r.P50Ms > p50Budget {
		t.Errorf("p50 %.3f ms is over the %.1f ms budget", r.P50Ms, p50Budget)
	}
	if r.P99Ms > p99Budget {
		t.Errorf("p99 %.3f ms is over the %.1f ms budget", r.P99Ms, p99Budget)
	}
}
