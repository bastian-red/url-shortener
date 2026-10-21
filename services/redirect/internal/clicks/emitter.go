// Package clicks puts one event per redirect on the `clicks` Redis Stream.
//
// The design constraint is that analytics can never slow a redirect down
// (SPECS outcome 2). So the handler does not XADD. It drops the event into a
// bounded channel and returns; a small pool of goroutines drains the channel
// and writes events in pipelined batches. If the channel is full -- Redis is
// slow or down -- the event is dropped and counted, and the visitor is
// redirected exactly as fast as before. Losing a click is a reporting error;
// a slow redirect is a product failure.
package clicks

import (
	"context"
	"log/slog"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/redis/go-redis/v9"
)

// Stream and Version match CLICK_STREAM / CLICK_EVENT_VERSION in
// packages/shared and contracts/click-event.schema.json.
const (
	Stream  = "clicks"
	Version = "1"
)

// Event is one redirect. Encode produces the stream fields.
type Event struct {
	LinkID   string
	Slug     string
	At       time.Time
	IP       string
	UA       string
	Referer  string
	Language string
}

// Field limits, in bytes. The JSON Schema and zod limits count characters
// (code points / UTF-16 units); both are always <= the byte count, so a value
// cut to N bytes satisfies a limit of N in either language.
const (
	maxUA   = 512
	maxRef  = 512
	maxLang = 64
	maxIP   = 45
)

// Encode returns the stream entry fields. Every field is always present.
func (e Event) Encode() map[string]any {
	return map[string]any{
		"v":    Version,
		"link": e.LinkID,
		"slug": e.Slug,
		"ts":   strconv.FormatInt(e.At.UnixMilli(), 10),
		"ip":   truncate(e.IP, maxIP),
		"ua":   truncate(e.UA, maxUA),
		"ref":  truncate(e.Referer, maxRef),
		"lang": truncate(e.Language, maxLang),
	}
}

// truncate cuts s to at most n bytes without splitting a UTF-8 sequence, and
// replaces invalid UTF-8 so the JSON-side validators never see a broken string.
func truncate(s string, n int) string {
	if !utf8.ValidString(s) {
		s = string([]rune(s)) // invalid bytes become U+FFFD
	}
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// Stats is read by /metrics.
type Stats interface {
	Emitted(n int)
	Dropped(n int)
}

// Emitter owns the queue and the writer goroutines.
type Emitter struct {
	rdb     redis.UniversalClient
	maxLen  int64
	queue   chan Event
	stats   Stats
	log     *slog.Logger
	wg      sync.WaitGroup
	batch   int
	linger  time.Duration
	closing chan struct{}
	once    sync.Once
}

// Options tune the emitter. Zero values pick the defaults.
type Options struct {
	QueueSize int           // default 10,000 events
	Workers   int           // default 4
	Batch     int           // default 128 events per pipeline
	Linger    time.Duration // default 2ms: how long a partial batch waits
}

func NewEmitter(rdb redis.UniversalClient, maxLen int64, stats Stats, log *slog.Logger, o Options) *Emitter {
	if o.QueueSize == 0 {
		o.QueueSize = 10_000
	}
	if o.Workers == 0 {
		o.Workers = 4
	}
	if o.Batch == 0 {
		o.Batch = 128
	}
	if o.Linger == 0 {
		o.Linger = 2 * time.Millisecond
	}
	e := &Emitter{
		rdb: rdb, maxLen: maxLen, stats: stats, log: log,
		queue: make(chan Event, o.QueueSize), batch: o.Batch, linger: o.Linger,
		closing: make(chan struct{}),
	}
	for range o.Workers {
		e.wg.Add(1)
		go e.run()
	}
	return e
}

// Emit never blocks. It reports whether the event was queued.
func (e *Emitter) Emit(ev Event) bool {
	select {
	case <-e.closing:
		e.stats.Dropped(1)
		return false
	default:
	}
	select {
	case e.queue <- ev:
		return true
	default:
		e.stats.Dropped(1)
		return false
	}
}

// Close stops accepting events and flushes what is queued, up to ctx's deadline.
func (e *Emitter) Close(ctx context.Context) {
	e.once.Do(func() { close(e.closing) })
	done := make(chan struct{})
	go func() { e.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		e.log.Warn("click emitter: shutdown deadline hit with events still queued", "queued", len(e.queue))
	}
}

// QueueDepth is exported for /metrics.
func (e *Emitter) QueueDepth() int { return len(e.queue) }

func (e *Emitter) run() {
	defer e.wg.Done()
	buf := make([]Event, 0, e.batch)
	timer := time.NewTimer(time.Hour)
	timer.Stop()
	for {
		select {
		case ev := <-e.queue:
			buf = append(buf, ev)
			if len(buf) == 1 {
				timer.Reset(e.linger)
			}
			if len(buf) >= e.batch {
				timer.Stop()
				buf = e.flush(buf)
			}
		case <-timer.C:
			buf = e.flush(buf)
		case <-e.closing:
			// Drain whatever is left, then exit.
			for {
				select {
				case ev := <-e.queue:
					buf = append(buf, ev)
					if len(buf) >= e.batch {
						buf = e.flush(buf)
					}
				default:
					e.flush(buf)
					return
				}
			}
		}
	}
}

func (e *Emitter) flush(buf []Event) []Event {
	if len(buf) == 0 {
		return buf
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	pipe := e.rdb.Pipeline()
	for _, ev := range buf {
		pipe.XAdd(ctx, &redis.XAddArgs{Stream: Stream, MaxLen: e.maxLen, Approx: true, Values: ev.Encode()})
	}
	if _, err := pipe.Exec(ctx); err != nil {
		e.stats.Dropped(len(buf))
		e.log.Error("click emitter: XADD pipeline failed", "events", len(buf), "err", err)
	} else {
		e.stats.Emitted(len(buf))
	}
	return buf[:0]
}
