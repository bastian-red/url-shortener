-- One redirect, one round trip.
--
-- KEYS[1] l:{slug}   the link record (contracts/link-cache.schema.json)
-- KEYS[2] n:{slug}   redirects granted so far (the click-limit counter)
-- KEYS[3] rl:{ip}    the client's GCRA theoretical arrival time, in ms
--
-- ARGV[1] now, epoch ms (the caller's clock, so tests can move time)
-- ARGV[2] emission interval ms (60000 / rate per minute)
-- ARGV[3] burst tolerance ms (interval * burst)
-- ARGV[4] "1" to apply the rate limit, "0" to skip it (the retry after a miss
--         already paid for this request)
-- ARGV[5] "1" to count this redirect against the click limit, "0" to only
--         check it (HEAD: a link checker probing a one-time link must not
--         spend it)
--
-- Replies, first element is the outcome:
--   {"limited", retry_after_ms}
--   {"miss"}                 no record; the caller loads Postgres and retries
--   {"notfound"}             negative-cache entry
--   {"disabled"} {"expired"} {"limit"}
--   {"ok", link_id, url}
--
-- Atomic because Redis runs a script to completion before serving anything
-- else. That is the whole click-limit guarantee: two requests cannot both read
-- "99 of 100" and both be granted the 100th.

local now = tonumber(ARGV[1])

if ARGV[4] == '1' then
  -- GCRA (generic cell rate algorithm): one key per client, no sorted sets, no
  -- per-request garbage. The key stores the theoretical arrival time (TAT) of
  -- the next request; a request is allowed if TAT - tolerance <= now.
  local interval = tonumber(ARGV[2])
  local tolerance = tonumber(ARGV[3])
  local tat = tonumber(redis.call('GET', KEYS[3])) or now
  if tat < now then tat = now end
  local allow_at = tat + interval - tolerance
  if allow_at > now then
    return {'limited', tostring(allow_at - now)}
  end
  local new_tat = tat + interval
  redis.call('SET', KEYS[3], tostring(new_tat), 'PX', math.max(1, math.ceil(new_tat - now)))
end

local rec = redis.call('HMGET', KEYS[1], 'id', 'url', 'exp', 'max', 'dis', 'nf')
if not rec[1] and not rec[6] then
  return {'miss'}
end
if rec[6] == '1' then return {'notfound'} end
if rec[5] == '1' then return {'disabled'} end

local exp = tonumber(rec[3]) or 0
if exp > 0 and exp <= now then return {'expired'} end

local max = tonumber(rec[4]) or 0
local granted = tonumber(redis.call('GET', KEYS[2])) or 0
if max > 0 and granted >= max then return {'limit'} end
if ARGV[5] == '1' then
  redis.call('INCR', KEYS[2])
end

return {'ok', rec[1], rec[2]}
