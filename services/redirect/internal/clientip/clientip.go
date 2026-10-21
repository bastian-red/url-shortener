// Package clientip decides which address a request came from.
//
// The address keys the rate limit and feeds the geo lookup, so getting it wrong
// in either direction is a bug: trusting X-Forwarded-For with no proxy in front
// lets any client pick its own rate-limit bucket (and country), while ignoring
// it behind a proxy puts every visitor in the proxy's bucket.
//
// The rule is the standard one. Each proxy APPENDS the address it received the
// connection from, so with N trusted proxies the client is the N-th entry from
// the right; everything left of that was supplied by the client and is ignored.
package clientip

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// From returns the client address for r, given how many trusted proxies sit in
// front of this process. It never returns an empty string: if a header is
// malformed it falls back to the socket peer, which at least is not forgeable.
func From(r *http.Request, trustedHops int) string {
	peer := remoteHost(r.RemoteAddr)
	if trustedHops <= 0 {
		return peer
	}

	var hops []string
	for _, header := range r.Header.Values("X-Forwarded-For") {
		for _, part := range strings.Split(header, ",") {
			if p := strings.TrimSpace(part); p != "" {
				hops = append(hops, p)
			}
		}
	}
	if len(hops) < trustedHops {
		// Fewer entries than proxies: the request did not come through all of
		// them (someone reached the service directly), so the header is not
		// evidence of anything.
		return peer
	}
	candidate := hops[len(hops)-trustedHops]
	addr, err := netip.ParseAddr(candidate)
	if err != nil {
		return peer
	}
	return addr.Unmap().String()
}

func remoteHost(remoteAddr string) string {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return remoteAddr
	}
	if addr, err := netip.ParseAddr(host); err == nil {
		return addr.Unmap().String()
	}
	return host
}
