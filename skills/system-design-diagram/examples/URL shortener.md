---
archslate: diagram
---

```archslate
# URL shortener
direction down

client web "Browser"
lb edge "Load balancer"
service api "Shortener API" x3 [stateless]
coordinator ids "ID ranges" [ZooKeeper, 1,000 ids per range]
cache hot "Hot links" [Redis, LRU]
db links "Links" [Cassandra, key: short code]
queue clicks "click.events"
worker stats "Analytics worker"
warehouse olap "Click warehouse"

web -> edge: GET /abc123
edge -> api
api -> ids: next free range
api -> hot: lookup
api -> links: read / insert
api --> clicks: Clicked
clicks --> stats
stats -> olap: batch insert [every minute]

flow redirect "Follow a short link" {
  web -> edge: GET /abc123
  edge -> api
  api -> hot: cached? answer 302 at once
  api -> links: not cached: read, then fill the cache
  api --> clicks: count the click, without waiting
}

flow create "Create a short link" {
  web -> edge: POST /links
  edge -> api
  api -> ids: a fresh range when its own runs out
  api -> links: insert code → long URL
}
```

## Requirements

- Redirect in **under 20 ms** (p99) for a cached link
- Reads outnumber writes about 100 to 1
- Click counts can lag by a few minutes

## Estimates

| | Value |
|---|---|
| New links / day | 1M |
| Redirects / day | 100M (~1,200/s, 5x at peak) |
| Storage, 5 years | 1.8B links × 500 B ≈ 1 TB |

## Trade-offs

- **Cassandra keyed by the short code**: every read is one partition, and writes scale out.
- **Ranges of ids**: each API instance takes 1,000 ids at a time, so creating a link needs no coordination;
  a crashed instance only wastes the rest of its range.
- The click goes to a queue so a slow analytics pipeline never slows a redirect.
