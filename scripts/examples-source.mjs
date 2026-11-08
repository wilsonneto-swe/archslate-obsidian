// The example diagrams (examples/*.md), written by `node scripts/examples-source.mjs`.
// They are notes like any other: edit the .md files directly from then on if you prefer.
import { writeFileSync } from 'node:fs';
import { serializeNewNote } from '../packages/core/document.js';
import { EXAMPLE_DOCUMENT } from '../apps/web/src/example.js';

const URL_SHORTENER = `# URL shortener
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
---

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
`;

const CHAT = `# Chat app
direction down

mobile phone "Phone app"
service ws "Chat gateway" xN [WebSocket, sticky sessions]
coordinator presence "Presence" [who is online, on which gateway]
service chat "Chat service" x3
db messages "Messages" [Cassandra, partition: chat_id]
stream events "message.events" [partitioned by chat_id]
worker push "Push worker"
external apns "APNs / FCM"
storage media "Media" [behind a CDN]

phone <-> ws: WebSocket
phone -> media: upload a photo [pre-signed URL]
ws -> presence: heartbeat
presence --> ws: contacts online / offline
ws -> chat: send
chat -> presence: recipient's gateway?
chat -> messages: append
chat --> events: MessageSent
events --> ws: deliver to the recipient's gateway
events --> push
push -> apns: wake offline devices

note presence "TTL-based: a gateway that stops heartbeating drops its users"

flow send "Send a message" {
  phone <-> ws: message over the open socket
  ws -> chat
  chat -> messages: store first
  chat -> presence: which gateway holds the recipient?
  chat --> events: then publish, keyed by chat
  events --> ws: the recipient's gateway
  ws -> phone: push down the recipient's socket
}

flow offline "Recipient is offline" {
  chat -> presence: nobody online for this user
  chat --> events
  events --> push
  push -> apns: notification
}

flow back "Back online" {
  phone <-> ws: reconnect
  ws -> chat: sync since the last message id
  chat -> messages: read what was missed
}
---

## Requirements

- 1:1 and group chats, delivered in order per chat
- Delivered when the recipient comes back online
- Online indicators within a few seconds

## Trade-offs

- Gateways hold the sockets; the chat service stays stateless and scales on its own.
- Ordering comes from the stream's partition key (\`chat_id\`), not from the clients' clocks.
- Store first, then publish: a crash between the two delays delivery until the recipient syncs. An outbox
  would close that gap.
- Online indicators: presence tells the gateways who came and went, and they tell the phones.
`;

const RATE_LIMITER = `# Rate limiter
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
---

## Rules

- A bucket per user holds up to 20 tokens and refills at 100 per minute: a steady 100 requests per minute,
  with bursts up to 20
- Over the limit: \`429 Too Many Requests\` with \`Retry-After\`

## Where to put it

The gateway asks the limiter before it passes a request on, so every service gets the limit for free. The
buckets live in Redis, shared by every gateway instance, so the limit holds across all of them.
`;

const files = {
  'URL shortener.md': serializeNewNote({ text: URL_SHORTENER, snapshots: [] }),
  'Chat app.md': serializeNewNote({ text: CHAT, snapshots: [] }),
  'Rate limiter.md': serializeNewNote({ text: RATE_LIMITER, snapshots: [] }),
  'Orders platform.md': serializeNewNote(EXAMPLE_DOCUMENT),
};
for (const [name, content] of Object.entries(files)) writeFileSync(new URL(`../examples/${name}`, import.meta.url), content);
// The skill carries two of them, so an agent has complete notes to look at.
for (const name of ['URL shortener.md', 'Chat app.md']) {
  writeFileSync(new URL(`../skills/system-design-diagram/examples/${name}`, import.meta.url), files[name]);
}
console.log(`wrote ${Object.keys(files).length} examples`);
