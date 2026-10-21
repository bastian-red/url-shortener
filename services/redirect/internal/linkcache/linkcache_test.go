package linkcache

import (
	"context"
	"fmt"
	"math/rand/v2"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// These run against a real Redis: the behaviour under test IS the Lua script's
// atomicity, which no fake reproduces. The integration lane sets
// REDIS_TEST_URL; the gate lane does not, and they skip there.
func testCache(t *testing.T, limit Limit) (*Cache, *redis.Client) {
	t.Helper()
	url := os.Getenv("REDIS_TEST_URL")
	if url == "" {
		t.Skip("REDIS_TEST_URL not set (integration lane only)")
	}
	opts, err := redis.ParseURL(url)
	if err != nil {
		t.Fatal(err)
	}
	rdb := redis.NewClient(opts)
	t.Cleanup(func() { _ = rdb.Close() })
	return New(rdb, limit), rdb
}

var generous = Limit{PerMinute: 1_000_000, Burst: 1_000_000}

func uniqueSlug(t *testing.T) string {
	return fmt.Sprintf("t%d%d", time.Now().UnixNano(), rand.IntN(1e6))
}

func cleanup(t *testing.T, rdb *redis.Client, slug string) {
	t.Cleanup(func() { rdb.Del(context.Background(), LinkPrefix+slug, CountPrefix+slug) })
}

func TestMissThenPopulateThenOK(t *testing.T) {
	c, rdb := testCache(t, generous)
	ctx, slug, now := context.Background(), uniqueSlug(t), time.Now()
	cleanup(t, rdb, slug)

	r, err := c.Resolve(ctx, slug, "203.0.113.1", now, Visit)
	if err != nil || r.Outcome != Miss {
		t.Fatalf("first resolve: %+v %v", r, err)
	}
	wrote, err := c.Populate(ctx, slug, Record{Found: true, ID: "link1", URL: "https://example.com/"}, time.Hour)
	if err != nil || !wrote {
		t.Fatalf("populate: %v %v", wrote, err)
	}
	r, err = c.Resolve(ctx, slug, "203.0.113.1", now, Mode{Count: true})
	if err != nil || r.Outcome != OK || r.URL != "https://example.com/" || r.LinkID != "link1" {
		t.Fatalf("second resolve: %+v %v", r, err)
	}
	if n, _ := rdb.Get(ctx, CountPrefix+slug).Int(); n != 1 {
		t.Fatalf("granted counter = %d, want 1", n)
	}
	if ttl := rdb.PTTL(ctx, LinkPrefix+slug).Val(); ttl <= 0 || ttl > time.Hour {
		t.Fatalf("record TTL = %v", ttl)
	}
}

// SPECS outcome 4: a link limited to N clicks grants exactly N redirects under
// concurrency. Revert-check: replacing the script's GET-then-INCR with a Go-side
// read and a separate INCR makes this grant more than 50.
func TestClickLimitIsExactUnderConcurrency(t *testing.T) {
	c, rdb := testCache(t, generous)
	ctx, slug := context.Background(), uniqueSlug(t)
	cleanup(t, rdb, slug)
	if _, err := c.Populate(ctx, slug, Record{Found: true, ID: "l", URL: "https://e.x/", MaxClicks: 50}, time.Hour); err != nil {
		t.Fatal(err)
	}

	var ok, limited atomic.Int64
	var wg sync.WaitGroup
	for i := range 200 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := c.Resolve(ctx, slug, fmt.Sprintf("198.51.100.%d", i%250), time.Now(), Visit)
			if err != nil {
				t.Error(err)
				return
			}
			switch r.Outcome {
			case OK:
				ok.Add(1)
			case LimitReached:
				limited.Add(1)
			default:
				t.Errorf("unexpected outcome %v", r.Outcome)
			}
		}()
	}
	wg.Wait()
	if ok.Load() != 50 || limited.Load() != 150 {
		t.Fatalf("granted %d, refused %d; want exactly 50 and 150", ok.Load(), limited.Load())
	}
	if n, _ := rdb.Get(ctx, CountPrefix+slug).Int(); n != 50 {
		t.Fatalf("counter = %d, want 50 (a refused request must not count)", n)
	}
}

func TestExpiryIsCheckedOnEveryHit(t *testing.T) {
	c, rdb := testCache(t, generous)
	ctx, slug := context.Background(), uniqueSlug(t)
	cleanup(t, rdb, slug)
	exp := time.UnixMilli(1_800_000_000_000)
	if _, err := c.Populate(ctx, slug, Record{Found: true, ID: "l", URL: "https://e.x/", ExpiresAt: exp}, time.Hour); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		at   time.Time
		want Outcome
	}{
		{exp.Add(-time.Millisecond), OK},
		{exp, Expired}, // the expiry instant itself is expired, as in linkStatus()
		{exp.Add(time.Hour), Expired},
	} {
		r, err := c.Resolve(ctx, slug, "203.0.113.2", tc.at, Visit)
		if err != nil || r.Outcome != tc.want {
			t.Fatalf("at %v: %+v %v, want %v", tc.at, r, err, tc.want)
		}
	}
}

func TestDisabledAndNegativeEntries(t *testing.T) {
	c, rdb := testCache(t, generous)
	ctx := context.Background()
	dis, gone := uniqueSlug(t), uniqueSlug(t)
	cleanup(t, rdb, dis)
	cleanup(t, rdb, gone)
	_, _ = c.Populate(ctx, dis, Record{Found: true, ID: "l", URL: "https://e.x/", Disabled: true}, time.Hour)
	_, _ = c.Populate(ctx, gone, Record{Found: false}, time.Minute)

	if r, _ := c.Resolve(ctx, dis, "203.0.113.3", time.Now(), Visit); r.Outcome != Disabled {
		t.Fatalf("disabled: %v", r.Outcome)
	}
	if r, _ := c.Resolve(ctx, gone, "203.0.113.3", time.Now(), Visit); r.Outcome != NotFound {
		t.Fatalf("negative: %v", r.Outcome)
	}
	if exists := rdb.Exists(ctx, CountPrefix+gone).Val(); exists != 0 {
		t.Fatal("a negative entry must not create a counter")
	}
}

// The race populate.lua exists for: the API wrote "disabled" after this
// redirect read the old row from Postgres. The stale write must lose.
func TestPopulateNeverOverwritesAWriteThrough(t *testing.T) {
	c, rdb := testCache(t, generous)
	ctx, slug := context.Background(), uniqueSlug(t)
	cleanup(t, rdb, slug)
	rdb.HSet(ctx, LinkPrefix+slug, Record{Found: true, ID: "l", URL: "https://new.example/", Disabled: true}.Fields())

	wrote, err := c.Populate(ctx, slug, Record{Found: true, ID: "l", URL: "https://old.example/"}, time.Hour)
	if err != nil || wrote {
		t.Fatalf("populate overwrote: %v %v", wrote, err)
	}
	if r, _ := c.Resolve(ctx, slug, "203.0.113.4", time.Now(), Visit); r.Outcome != Disabled {
		t.Fatalf("got %v, the API's write was lost", r.Outcome)
	}
}

func TestPopulateSeedsTheCounterFromPostgresButNeverLowersIt(t *testing.T) {
	c, rdb := testCache(t, generous)
	ctx, slug := context.Background(), uniqueSlug(t)
	cleanup(t, rdb, slug)

	_, _ = c.Populate(ctx, slug, Record{Found: true, ID: "l", URL: "https://e.x/", MaxClicks: 10, Counted: 9}, time.Hour)
	if r, _ := c.Resolve(ctx, slug, "203.0.113.5", time.Now(), Visit); r.Outcome != OK {
		t.Fatalf("10th click: %v", r.Outcome)
	}
	if r, _ := c.Resolve(ctx, slug, "203.0.113.5", time.Now(), Visit); r.Outcome != LimitReached {
		t.Fatalf("11th click: %v (counter was not seeded from Postgres)", r.Outcome)
	}

	// Record expires, a later populate carries an older count: the counter stays.
	rdb.Del(ctx, LinkPrefix+slug)
	_, _ = c.Populate(ctx, slug, Record{Found: true, ID: "l", URL: "https://e.x/", MaxClicks: 10, Counted: 3}, time.Hour)
	if n, _ := rdb.Get(ctx, CountPrefix+slug).Int(); n != 10 {
		t.Fatalf("counter = %d, want 10", n)
	}
}

func TestRateLimitAllowsTheBurstThenRefusesWithRetryAfter(t *testing.T) {
	limit := Limit{PerMinute: 60, Burst: 5} // one per second, five extra
	c, rdb := testCache(t, limit)
	ctx, slug := context.Background(), uniqueSlug(t)
	cleanup(t, rdb, slug)
	_, _ = c.Populate(ctx, slug, Record{Found: true, ID: "l", URL: "https://e.x/"}, time.Hour)
	ip := fmt.Sprintf("192.0.2.%d", rand.IntN(250))
	t.Cleanup(func() { rdb.Del(ctx, ratePrefix+ip) })

	now := time.Now()
	for i := range 5 {
		if r, _ := c.Resolve(ctx, slug, ip, now, Visit); r.Outcome != OK {
			t.Fatalf("request %d inside the burst: %v", i+1, r.Outcome)
		}
	}
	r, _ := c.Resolve(ctx, slug, ip, now, Visit)
	if r.Outcome != RateLimited || r.RetryAfter <= 0 || r.RetryAfter > time.Second {
		t.Fatalf("6th request: %+v, want rate limited with a retry under 1s", r)
	}
	// Another client is unaffected.
	if r, _ := c.Resolve(ctx, slug, ip+"0", now, Visit); r.Outcome != OK {
		t.Fatalf("other client: %v", r.Outcome)
	}
	rdb.Del(ctx, ratePrefix+ip+"0")
	// One emission interval later, one more is allowed.
	if r, _ := c.Resolve(ctx, slug, ip, now.Add(time.Second), Visit); r.Outcome != OK {
		t.Fatalf("after a second: %v", r.Outcome)
	}
}

func TestHeadChecksWithoutSpendingAOneTimeLink(t *testing.T) {
	c, rdb := testCache(t, generous)
	ctx, slug := context.Background(), uniqueSlug(t)
	cleanup(t, rdb, slug)
	_, _ = c.Populate(ctx, slug, Record{Found: true, ID: "l", URL: "https://e.x/", MaxClicks: 1}, time.Hour)
	head := Mode{RateLimit: true, Count: false}
	for range 3 {
		if r, _ := c.Resolve(ctx, slug, "203.0.113.6", time.Now(), head); r.Outcome != OK {
			t.Fatalf("HEAD: %v", r.Outcome)
		}
	}
	if r, _ := c.Resolve(ctx, slug, "203.0.113.6", time.Now(), Visit); r.Outcome != OK {
		t.Fatalf("the one real visit: %v", r.Outcome)
	}
	if r, _ := c.Resolve(ctx, slug, "203.0.113.6", time.Now(), Visit); r.Outcome != LimitReached {
		t.Fatalf("second visit: %v", r.Outcome)
	}
}

func TestParseRejectsUnknownReplies(t *testing.T) {
	if _, err := parse([]any{"surprise"}); err == nil {
		t.Fatal("accepted an unknown reply")
	}
	if _, err := parse(nil); err == nil {
		t.Fatal("accepted an empty reply")
	}
	if r, err := parse([]any{"limited", "1500"}); err != nil || r.RetryAfter != 1500*time.Millisecond {
		t.Fatalf("limited: %+v %v", r, err)
	}
}
