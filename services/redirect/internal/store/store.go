// Package store loads a link from Postgres on a cache miss. It is the only SQL
// the redirect service runs, and it never runs on a cache hit.
package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/bastian-red/url-shortener/services/redirect/internal/linkcache"
)

// Store wraps a pgx pool.
type Store struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// One query: the link and every click Postgres has counted for it, so a cold
// cache seeds the click-limit counter in the same round trip. A soft-deleted
// link is "not found": its slug is never reused (see schema.prisma), but it no
// longer redirects.
const loadSQL = `
SELECT l.id, l.url, l.expires_at, COALESCE(l.max_clicks, 0), l.disabled,
       COALESCE((SELECT SUM(h.clicks + h.bots) FROM link_hours h WHERE h.link_id = l.id), 0)
  FROM links l
 WHERE l.slug = $1 AND l.deleted_at IS NULL`

// Load returns the record to cache. A missing slug is Found=false, not an error.
func (s *Store) Load(ctx context.Context, slug string) (linkcache.Record, error) {
	var (
		r   = linkcache.Record{Found: true}
		exp *time.Time
	)
	err := s.pool.QueryRow(ctx, loadSQL, slug).Scan(&r.ID, &r.URL, &exp, &r.MaxClicks, &r.Disabled, &r.Counted)
	if errors.Is(err, pgx.ErrNoRows) {
		return linkcache.Record{Found: false}, nil
	}
	if err != nil {
		return linkcache.Record{}, err
	}
	if exp != nil {
		r.ExpiresAt = *exp
	}
	return r, nil
}

// Ping is the health check.
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }
