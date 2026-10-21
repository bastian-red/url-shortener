-- Write a link record loaded from Postgres, but only if nobody wrote one first.
--
-- KEYS[1] l:{slug}   KEYS[2] n:{slug}
-- ARGV: id, url, exp, max, dis, nf, ttl_ms, granted
--
-- The API writes this key on every link change (write-through). A redirect that
-- missed the cache read Postgres BEFORE that change committed and is now about
-- to write what it read; if it overwrote, a disabled link would come back to
-- life for a whole TTL. Set-if-absent makes the API's write win every such race:
-- the API always writes (it never deletes; a deleted link becomes nf = "1"), so
-- if the key exists at all, it is at least as new as what this caller read.
--
-- The counter is seeded the same way (SET NX) from the clicks Postgres has
-- counted, so a Redis that lost its data does not hand a 100-click link a fresh
-- 100. Postgres lags the stream, so this can under-count by the clicks still in
-- flight; it can never reset to zero.

if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('HSET', KEYS[1],
  'id', ARGV[1], 'url', ARGV[2], 'exp', ARGV[3], 'max', ARGV[4], 'dis', ARGV[5], 'nf', ARGV[6])
redis.call('PEXPIRE', KEYS[1], ARGV[7])
if ARGV[6] == '0' then
  redis.call('SET', KEYS[2], ARGV[8], 'NX')
end
return 1
