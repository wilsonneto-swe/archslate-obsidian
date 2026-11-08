---
archslate: diagram
---

```archslate
# Orders platform, v3: outbox + async payments
direction down

client web "Web App"
gateway api "API Gateway" [auth, rate limits]

group orders_ctx "Orders" {
  service orders "Orders API" x3 [stateless]
  db orders_db "Orders DB" [Postgres]
  note orders_db "Order and outbox rows are written in one transaction, so an event can't be lost"
}

stream order_events "order.events" [partitioned by order_id]

group payments_ctx "Payments" {
  worker payments "Payments" x2
  db payments_db "Payments DB"
}

group notify_ctx "Notifications" {
  queue email_q "email.queue"
  worker notifications "Mailer"
}

service status "Order Status" [WebSocket fan-out]
external psp "Payment Provider"
external smtp "Email Provider"

web -> api: HTTPS
api -> orders: POST /orders [idempotency key]
orders -> orders_db: order + outbox
orders_db --> order_events: CDC
order_events --> payments: OrderPlaced
payments --> order_events: PaymentSucceeded / PaymentFailed
order_events --> orders: payment result
order_events --> email_q: PaymentSucceeded
email_q --> notifications
order_events --> status
payments -> payments_db
payments -> psp: charge [timeout 5s, 3 retries]
notifications -> smtp
web <-> status: WebSocket

flow place_order "Place an order" {
  web -> api: submit
  api -> orders: POST /orders
  orders -> orders_db: commit order + outbox
  orders_db --> order_events: CDC publishes OrderPlaced
  order_events --> payments: charge, async
  payments -> psp: charge card
  payments --> order_events: PaymentSucceeded
  order_events --> orders: mark the order paid
  order_events --> status: status changed
  status -> web: push "order paid"
}

flow receipt "Send the receipt" {
  payments --> order_events: PaymentSucceeded
  order_events --> email_q: only for a paid order
  email_q --> notifications
  notifications -> smtp: send email
}

```

## Requirements

- Confirm an order in **< 200 ms** (p99)
- Payment and email happen **asynchronously**
- No order event may be lost, even while the stream is down

## Estimates

| | Value |
|---|---|
| Orders / day | 2M |
| Peak writes | ~120/s (5x average) |
| Events / day | ~4M published (OrderPlaced, then the payment's result) |

## Trade-offs

- **Outbox + CDC** instead of a dual write: one transaction, no lost events. Costs CDC infrastructure and ~1 s of lag.
- Payments is a consumer now. Retries are safe because the order id is the idempotency key.
- [ ] Open question: what if the payment provider is down for an hour? DLQ and replay?

%% archslate:versions
{"name":"v1 monolith","createdAt":"2026-11-01T14:00:00.000Z","id":"seed-v1","text":"# Orders platform, v1: one deployable, everything synchronous\ndirection down\n\nclient web \"Web App\"\nlb edge \"Load Balancer\"\n\ngroup monolith \"Monolith\" {\n  service orders \"Orders\"\n  service payments \"Payments\"\n  service notifications \"Notifications\"\n}\n\ndb main_db \"Main DB\" [Postgres]\nexternal psp \"Payment Provider\"\nexternal smtp \"Email Provider\"\n\nweb -> edge: HTTPS\nedge -> orders\norders -> payments: charge\norders -> notifications: send receipt\norders -> main_db\npayments -> main_db\npayments -> psp: REST\nnotifications -> smtp\n\n---\n\n## Starting point\n\nOne deployable and one database. Simple to build and to run, but:\n\n- a slow email provider makes **checkout** slow, because the receipt is sent inside the request\n- payments can't scale on their own\n"}
{"name":"v2 events","createdAt":"2026-11-04T18:30:00.000Z","id":"seed-v2","text":"# Orders platform, v2: split services, notifications go async\ndirection down\n\nclient web \"Web App\"\ngateway api \"API Gateway\"\n\ngroup orders_ctx \"Orders\" {\n  service orders \"Orders API\"\n  db orders_db \"Orders DB\" [Postgres]\n}\n\ngroup payments_ctx \"Payments\" {\n  service payments \"Payments\"\n  db payments_db \"Payments DB\"\n}\n\ntopic order_events \"order.events\"\nworker notifications \"Notifications\"\nexternal psp \"Payment Provider\"\nexternal smtp \"Email Provider\"\n\nweb -> api: HTTPS\napi -> orders: POST /orders\norders -> orders_db\norders -> payments: charge\npayments -> payments_db\npayments -> psp: REST\norders --> order_events: OrderPlaced\norder_events --> notifications\nnotifications -> smtp\n\n---\n\n## Why split\n\n- Orders and Payments deploy and scale independently\n- Email is an event now: checkout no longer waits for SMTP\n\n## Problem found\n\n`orders` writes to its database **and** publishes the event. If the publish\nfails after the commit, the event is lost (a *dual write*). Fixed in v3.\n"}
%%
