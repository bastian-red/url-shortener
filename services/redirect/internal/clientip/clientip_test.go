package clientip

import (
	"net/http/httptest"
	"testing"
)

func TestFrom(t *testing.T) {
	cases := []struct {
		name string
		xff  []string
		hops int
		want string
	}{
		{"no proxy ignores the header entirely", []string{"1.2.3.4"}, 0, "10.0.0.9"},
		{"one proxy takes the rightmost entry", []string{"9.9.9.9, 1.2.3.4"}, 1, "1.2.3.4"},
		{"a spoofed leftmost entry is ignored", []string{"6.6.6.6, 1.2.3.4"}, 1, "1.2.3.4"},
		{"two proxies take the second from the right", []string{"6.6.6.6, 1.2.3.4, 172.16.0.2"}, 2, "1.2.3.4"},
		{"repeated headers are one list", []string{"6.6.6.6", "1.2.3.4"}, 1, "1.2.3.4"},
		{"fewer entries than proxies falls back to the peer", []string{"1.2.3.4"}, 2, "10.0.0.9"},
		{"garbage falls back to the peer", []string{"not-an-ip"}, 1, "10.0.0.9"},
		{"IPv6 is kept", []string{"2001:db8::1"}, 1, "2001:db8::1"},
		{"IPv4-mapped IPv6 becomes IPv4", []string{"::ffff:1.2.3.4"}, 1, "1.2.3.4"},
		{"no header falls back to the peer", nil, 1, "10.0.0.9"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/x", nil)
			r.RemoteAddr = "10.0.0.9:51000"
			for _, v := range tc.xff {
				r.Header.Add("X-Forwarded-For", v)
			}
			if got := From(r, tc.hops); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
