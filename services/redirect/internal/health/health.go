// Package health builds the /health body: the same JSON shape all three
// services emit (contracts/health.schema.json), so the API's /status page and
// the E2E suite parse one format.
package health

import (
	"context"
	"sync"
	"time"
)

// Check is one dependency probe.
type Check struct {
	Name  string
	Probe func(context.Context) error
}

// CheckResult matches healthCheckSchema in packages/shared.
type CheckResult struct {
	Name      string  `json:"name"`
	Status    string  `json:"status"`
	LatencyMs int64   `json:"latencyMs"`
	Detail    *string `json:"detail"`
}

// Report matches healthSchema in packages/shared.
type Report struct {
	Status        string        `json:"status"`
	Service       string        `json:"service"`
	Version       string        `json:"version"`
	UptimeSeconds int64         `json:"uptimeSeconds"`
	Checks        []CheckResult `json:"checks"`
}

// Run probes every check in parallel, each bounded by timeout, and reports
// "degraded" if any failed. A probe that hangs is a failure, not a slow pass:
// a health endpoint that waits forever on a dead database is itself down.
func Run(ctx context.Context, service, version string, started time.Time, timeout time.Duration, checks []Check) Report {
	results := make([]CheckResult, len(checks))
	var wg sync.WaitGroup
	for i, c := range checks {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cctx, cancel := context.WithTimeout(ctx, timeout)
			defer cancel()
			begin := time.Now()
			err := c.Probe(cctx)
			res := CheckResult{Name: c.Name, Status: "ok", LatencyMs: time.Since(begin).Milliseconds()}
			if err != nil {
				msg := err.Error()
				if cctx.Err() != nil {
					msg = "timeout after " + timeout.String()
				}
				res.Status, res.Detail = "fail", &msg
			}
			results[i] = res
		}()
	}
	wg.Wait()

	status := "ok"
	for _, r := range results {
		if r.Status != "ok" {
			status = "degraded"
		}
	}
	return Report{
		Status: status, Service: service, Version: version,
		UptimeSeconds: int64(time.Since(started).Seconds()), Checks: results,
	}
}
