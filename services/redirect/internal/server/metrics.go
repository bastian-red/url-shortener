package server

import (
	"github.com/prometheus/client_golang/prometheus"
)

// Metrics is what /metrics exposes. The redirect histogram is the production
// twin of the load test: the same latency, measured on live traffic.
type Metrics struct {
	Registry  *prometheus.Registry
	duration  *prometheus.HistogramVec
	misses    prometheus.Counter
	emitted   prometheus.Counter
	dropped   prometheus.Counter
	degraded  prometheus.Counter
	queueSize prometheus.GaugeFunc
}

// NewMetrics registers everything on a private registry (no global state, so
// tests can build as many servers as they like).
func NewMetrics(queueDepth func() int) *Metrics {
	m := &Metrics{
		Registry: prometheus.NewRegistry(),
		duration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "redirect_duration_seconds",
			Help: "Time from request to response for GET/HEAD /{slug}, by outcome.",
			// Sub-millisecond buckets: a cache hit is expected well under 1 ms, so
			// the default buckets (starting at 5 ms) would put every hit in one bin.
			Buckets: []float64{.0001, .00025, .0005, .001, .0025, .005, .01, .025, .05, .1, .25, 1},
		}, []string{"outcome"}),
		misses:   prometheus.NewCounter(prometheus.CounterOpts{Name: "redirect_cache_misses_total", Help: "Resolves that went to Postgres."}),
		emitted:  prometheus.NewCounter(prometheus.CounterOpts{Name: "clicks_emitted_total", Help: "Click events written to the stream."}),
		dropped:  prometheus.NewCounter(prometheus.CounterOpts{Name: "clicks_dropped_total", Help: "Click events lost: queue full or XADD failed."}),
		degraded: prometheus.NewCounter(prometheus.CounterOpts{Name: "redirect_degraded_total", Help: "Redirects answered from Postgres because Redis failed."}),
	}
	m.queueSize = prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: "clicks_queue_depth", Help: "Click events waiting to be written."},
		func() float64 { return float64(queueDepth()) })
	m.Registry.MustRegister(m.duration, m.misses, m.emitted, m.dropped, m.degraded, m.queueSize,
		prometheus.NewGoCollector(), prometheus.NewProcessCollector(prometheus.ProcessCollectorOpts{}))
	return m
}

// Emitted and Dropped satisfy clicks.Stats.
func (m *Metrics) Emitted(n int) { m.emitted.Add(float64(n)) }
func (m *Metrics) Dropped(n int) { m.dropped.Add(float64(n)) }
