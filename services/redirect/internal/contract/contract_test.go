// Package contract holds the Go half of the cross-language contract
// (contracts/README.md). The TypeScript half is
// packages/shared/src/contracts/cross-language.test.ts.
//
// Each Go encoder's output is validated against the same JSON Schema the
// TypeScript side validates its fixture against, and re-encoding the golden
// fixture's values must reproduce the fixture byte for byte. Rename a field on
// either side and one of the two halves goes red.
package contract

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/bastian-red/url-shortener/services/redirect/internal/clicks"
	"github.com/bastian-red/url-shortener/services/redirect/internal/health"
	"github.com/bastian-red/url-shortener/services/redirect/internal/linkcache"
)

var root = filepath.Join("..", "..", "..", "..", "contracts")

func schema(t *testing.T, name string) *jsonschema.Schema {
	t.Helper()
	c := jsonschema.NewCompiler()
	s, err := c.Compile(filepath.Join(root, name+".schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func fixture(t *testing.T, name string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(root, "fixtures", name+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// roundTrip turns any Go value into the generic JSON shape the validator reads.
func roundTrip(t *testing.T, v any) any {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestClickEventEncodesTheFixtureExactly(t *testing.T) {
	f := fixture(t, "click-event")
	ms, _ := strconv.ParseInt(f["ts"].(string), 10, 64)
	ev := clicks.Event{
		LinkID: f["link"].(string), Slug: f["slug"].(string), At: time.UnixMilli(ms),
		IP: f["ip"].(string), UA: f["ua"].(string), Referer: f["ref"].(string), Language: f["lang"].(string),
	}
	got := roundTrip(t, ev.Encode())
	if !reflect.DeepEqual(got, any(f)) {
		t.Fatalf("encoded event differs from the golden fixture\n got: %v\nwant: %v", got, f)
	}
	if err := schema(t, "click-event").Validate(got); err != nil {
		t.Fatal(err)
	}
}

func TestClickEventStaysValidAtTheLimits(t *testing.T) {
	// Oversized, multi-byte and invalid-UTF-8 input: truncation must keep every
	// field inside the schema without splitting a character.
	ev := clicks.Event{
		LinkID: "l", Slug: "s", At: time.UnixMilli(1),
		IP: strings.Repeat("f", 100), UA: strings.Repeat("é", 400) + "\xff",
		Referer: strings.Repeat("🙂", 200), Language: strings.Repeat("x", 100),
	}
	enc := ev.Encode()
	if err := schema(t, "click-event").Validate(roundTrip(t, enc)); err != nil {
		t.Fatal(err)
	}
	for k, v := range enc {
		if s := v.(string); strings.ContainsRune(s, '�') && k != "ua" {
			t.Errorf("%s was split mid-character", k)
		}
	}
}

func TestLinkCacheRecordsValidate(t *testing.T) {
	s := schema(t, "link-cache")
	for name, rec := range map[string]linkcache.Record{
		"full":     {Found: true, ID: "cm9", URL: "https://e.x/", ExpiresAt: time.UnixMilli(1792584000000), MaxClicks: 100, Disabled: true},
		"minimal":  {Found: true, ID: "cm9", URL: "https://e.x/"},
		"negative": {Found: false},
	} {
		if err := s.Validate(roundTrip(t, rec.Fields())); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	f := fixture(t, "link-cache")
	exp, _ := strconv.ParseInt(f["exp"].(string), 10, 64)
	max, _ := strconv.ParseInt(f["max"].(string), 10, 64)
	rec := linkcache.Record{Found: true, ID: f["id"].(string), URL: f["url"].(string), ExpiresAt: time.UnixMilli(exp), MaxClicks: max}
	if got := roundTrip(t, rec.Fields()); !reflect.DeepEqual(got, any(f)) {
		t.Fatalf("record differs from the golden fixture\n got: %v\nwant: %v", got, f)
	}
}

func TestHealthReportValidates(t *testing.T) {
	report := health.Run(httptest.NewRequest("GET", "/", nil).Context(), "redirect", "0.1.0", time.Now(), time.Second, nil)
	if err := schema(t, "health").Validate(roundTrip(t, report)); err != nil {
		t.Fatal(err)
	}
	if err := schema(t, "health").Validate(any(fixture(t, "health"))); err != nil {
		t.Fatal(err)
	}
}
