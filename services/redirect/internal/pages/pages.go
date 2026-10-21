// Package pages renders the redirect service's own error pages.
//
// The service answers these itself, with the real status code, rather than
// redirecting to the web app: a crawler or a link checker must see 404 for a
// slug that never existed and 410 for one that did, and a redirect to a
// "not found" page answers 302 to both.
package pages

import (
	_ "embed"
	"html/template"
	"net/http"
	"strconv"
)

//go:embed page.html
var source string

var tmpl = template.Must(template.New("page").Parse(source))

// Kind is which page to render.
type Kind int

const (
	NotFound Kind = iota
	Expired
	LimitReached
	Disabled
	TooManyRequests
	Unavailable
)

type copyText struct {
	status         int
	glyph, word    string
	title, message string
	showSlug       bool
}

// Every state carries a glyph AND a word (DESIGN.md: colour is never the only
// channel; here there is no colour at all, so the word is the channel).
var texts = map[Kind]copyText{
	NotFound:        {404, "✕", "Not found", "No link here", "Short links are case-sensitive, so check the address for a typo. Nothing is registered at", true},
	Expired:         {410, "⌛", "Expired", "This link has expired", "Its owner set an end date, and it has passed. The link was", true},
	LimitReached:    {410, "⊘", "Limit reached", "This link has been used up", "Its owner allowed a fixed number of visits, and they have all been used. The link was", true},
	Disabled:        {410, "⏸", "Turned off", "This link has been turned off", "Its owner has paused it. The link is", true},
	TooManyRequests: {429, "⧗", "Slow down", "Too many requests", "This address has opened a lot of links in a short time. Wait a moment and try again.", false},
	Unavailable:     {503, "!", "Unavailable", "Short links are briefly unavailable", "Something behind this service is not answering. Try again in a minute.", false},
}

type view struct {
	Status                      int
	Glyph, Word, Title, Message string
	Slug, Home                  string
}

// Write renders kind with its status code. slug is shown escaped, never as HTML.
func Write(w http.ResponseWriter, kind Kind, slug, home string, retryAfterSeconds int) {
	t := texts[kind]
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Robots-Tag", "noindex")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
	if kind == TooManyRequests && retryAfterSeconds > 0 {
		h.Set("Retry-After", strconv.Itoa(retryAfterSeconds))
	}
	w.WriteHeader(t.status)
	v := view{Status: t.status, Glyph: t.glyph, Word: t.word, Title: t.title, Message: t.message, Home: home}
	if t.showSlug {
		v.Slug = slug
	}
	_ = tmpl.Execute(w, v)
}

// Status is exported for tests and metrics.
func Status(kind Kind) int { return texts[kind].status }
