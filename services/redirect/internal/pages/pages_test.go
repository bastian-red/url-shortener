package pages

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEveryKindHasAStatusAGlyphAndAWord(t *testing.T) {
	want := map[Kind]int{NotFound: 404, Expired: 410, LimitReached: 410, Disabled: 410, TooManyRequests: 429, Unavailable: 503}
	for kind, status := range want {
		rec := httptest.NewRecorder()
		Write(rec, kind, "aB3", "http://localhost:3000", 2)
		body := rec.Body.String()
		if rec.Code != status {
			t.Errorf("kind %d: status %d, want %d", kind, rec.Code, status)
		}
		tx := texts[kind]
		if !strings.Contains(body, tx.glyph) || !strings.Contains(body, tx.word) {
			t.Errorf("kind %d: missing glyph or word", kind)
		}
		if !strings.Contains(body, `<main>`) || !strings.Contains(body, `<h1>`) || !strings.Contains(body, `lang="en"`) {
			t.Errorf("kind %d: missing landmark, heading or lang", kind)
		}
	}
}

func TestSlugIsEscaped(t *testing.T) {
	rec := httptest.NewRecorder()
	Write(rec, NotFound, `<script>alert(1)</script>`, "http://x", 0)
	if strings.Contains(rec.Body.String(), "<script>alert") {
		t.Fatal("slug rendered as HTML")
	}
}

func TestRetryAfterOnlyOn429(t *testing.T) {
	rec := httptest.NewRecorder()
	Write(rec, TooManyRequests, "", "http://x", 3)
	if rec.Header().Get("Retry-After") != "3" {
		t.Fatalf("Retry-After = %q", rec.Header().Get("Retry-After"))
	}
	rec = httptest.NewRecorder()
	Write(rec, NotFound, "", "http://x", 3)
	if rec.Header().Get("Retry-After") != "" {
		t.Fatal("Retry-After on a 404")
	}
}
