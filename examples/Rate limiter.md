---
archslate: diagram
---

```archslate
# Rate limiter
direction right

client app "Client"
gateway api "API gateway" x2
ratelimiter limiter "Rate limiter" [token bucket, per user]
cache buckets "Buckets" [Redis cluster, tokens + last refill]
service backend "Backend" x4

app -> api: request
api -> limiter: allowed?
limiter -> buckets: take a token [one Lua script, atomic]
api -> backend: only when allowed

note limiter "Fail open: if Redis is down, let requests through and alert"

flow limited "A request over the limit" {
  app -> api: request
  api -> limiter: allowed?
  limiter -> buckets: bucket empty: answer 429
}
```

## Rules

- A bucket per user holds up to 20 tokens and refills at 100 per minute: a steady 100 requests per minute,
  with bursts up to 20
- Over the limit: `429 Too Many Requests` with `Retry-After`

## Where to put it

The gateway asks the limiter before it passes a request on, so every service gets the limit for free. The
buckets live in Redis, shared by every gateway instance, so the limit holds across all of them.
