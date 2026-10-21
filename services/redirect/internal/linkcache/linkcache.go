// Package linkcache is the redirect service's view of Redis: one script call
// per redirect, plus the set-if-absent populate used after a miss.
package linkcache

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// Key prefixes. The same strings are LINK_CACHE_PREFIX / CLICK_COUNT_PREFIX in
// packages/shared, which the API writes through.
const (
	LinkPrefix  = "l:"
	CountPrefix = "n:"
	ratePrefix  = "rl:"
)

//go:embed resolve.lua
var resolveSource string

//go:embed populate.lua
var populateSource string

var (
	resolveScript  = redis.NewScript(resolveSource)
	populateScript = redis.NewScript(populateSource)
)

// Outcome of one resolve.
type Outcome int

const (
	OK Outcome = iota
	Miss
	NotFound
	Disabled
	Expired
	LimitReached
	RateLimited
)

func (o Outcome) String() string {
	return [...]string{"ok", "miss", "not_found", "disabled", "expired", "limit_reached", "rate_limited"}[o]
}

// Result of one resolve. LinkID and URL are set only for OK; RetryAfter only
// for RateLimited.
type Result struct {
	Outcome    Outcome
	LinkID     string
	URL        string
	RetryAfter time.Duration
}

// Limit is a GCRA rate: PerMinute sustained, Burst extra.
type Limit struct {
	PerMinute int
	Burst     int
}

// Cache wraps a Redis client.
type Cache struct {
	rdb   redis.UniversalClient
	limit Limit
}

func New(rdb redis.UniversalClient, limit Limit) *Cache {
	return &Cache{rdb: rdb, limit: limit}
}

// Mode says what a resolve should spend.
type Mode struct {
	// RateLimit is false only for the retry after a miss, which the first call
	// already charged to the client's bucket.
	RateLimit bool
	// Count is false for HEAD: checking a one-time link must not use it up.
	Count bool
}

// Visit is a GET: rate limited and counted.
var Visit = Mode{RateLimit: true, Count: true}

// Resolve runs the resolve script.
func (c *Cache) Resolve(ctx context.Context, slug, ip string, now time.Time, mode Mode) (Result, error) {
	interval := 60_000.0 / float64(c.limit.PerMinute)
	tolerance := interval * float64(c.limit.Burst)
	raw, err := resolveScript.Run(ctx, c.rdb,
		[]string{LinkPrefix + slug, CountPrefix + slug, ratePrefix + ip},
		now.UnixMilli(), strconv.FormatFloat(interval, 'f', 3, 64), strconv.FormatFloat(tolerance, 'f', 3, 64),
		flag(mode.RateLimit), flag(mode.Count),
	).Slice()
	if err != nil {
		return Result{}, fmt.Errorf("resolve script: %w", err)
	}
	return parse(raw)
}

func flag(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

func parse(raw []any) (Result, error) {
	if len(raw) == 0 {
		return Result{}, errors.New("resolve script: empty reply")
	}
	tag, _ := raw[0].(string)
	switch tag {
	case "ok":
		if len(raw) != 3 {
			return Result{}, errors.New("resolve script: malformed ok reply")
		}
		id, _ := raw[1].(string)
		url, _ := raw[2].(string)
		return Result{Outcome: OK, LinkID: id, URL: url}, nil
	case "limited":
		ms := 1000.0
		if len(raw) == 2 {
			if s, ok := raw[1].(string); ok {
				if v, err := strconv.ParseFloat(s, 64); err == nil {
					ms = v
				}
			}
		}
		return Result{Outcome: RateLimited, RetryAfter: time.Duration(ms * float64(time.Millisecond))}, nil
	case "miss":
		return Result{Outcome: Miss}, nil
	case "notfound":
		return Result{Outcome: NotFound}, nil
	case "disabled":
		return Result{Outcome: Disabled}, nil
	case "expired":
		return Result{Outcome: Expired}, nil
	case "limit":
		return Result{Outcome: LimitReached}, nil
	}
	return Result{}, fmt.Errorf("resolve script: unknown reply %q", tag)
}

// Record is a link as Postgres knows it, ready to be cached. Found=false writes
// a negative-cache entry.
type Record struct {
	Found     bool
	ID        string
	URL       string
	ExpiresAt time.Time // zero = never
	MaxClicks int64     // 0 = no limit
	Disabled  bool
	// Counted is every click Postgres has recorded (humans and bots), used to
	// seed the click-limit counter if Redis has none.
	Counted int64
}

// Fields encodes r as the cache hash. Exported so the contract test can
// validate it against contracts/link-cache.schema.json.
func (r Record) Fields() map[string]string {
	if !r.Found {
		return map[string]string{"id": "", "url": "", "exp": "0", "max": "0", "dis": "0", "nf": "1"}
	}
	exp := int64(0)
	if !r.ExpiresAt.IsZero() {
		exp = r.ExpiresAt.UnixMilli()
	}
	dis := "0"
	if r.Disabled {
		dis = "1"
	}
	return map[string]string{
		"id": r.ID, "url": r.URL,
		"exp": strconv.FormatInt(exp, 10), "max": strconv.FormatInt(r.MaxClicks, 10),
		"dis": dis, "nf": "0",
	}
}

// Populate writes r unless a record already exists. Returns whether it wrote.
func (c *Cache) Populate(ctx context.Context, slug string, r Record, ttl time.Duration) (bool, error) {
	f := r.Fields()
	n, err := populateScript.Run(ctx, c.rdb,
		[]string{LinkPrefix + slug, CountPrefix + slug},
		f["id"], f["url"], f["exp"], f["max"], f["dis"], f["nf"], ttl.Milliseconds(), r.Counted,
	).Int()
	if err != nil {
		return false, fmt.Errorf("populate script: %w", err)
	}
	return n == 1, nil
}

// Ping is the health check.
func (c *Cache) Ping(ctx context.Context) error { return c.rdb.Ping(ctx).Err() }
