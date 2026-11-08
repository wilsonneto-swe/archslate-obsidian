// Seed document for the web shell: one diagram with two saved versions, so the
// version timeline and "Show changes" have something to show on first load.
// It also exercises details, instance counts, notes, flows, a connection and
// the markdown section, which each version carries with it.

const V1 = `# Orders platform, v1: one deployable, everything synchronous
direction down

client web "Web App"
lb edge "Load Balancer"

group monolith "Monolith" {
  service orders "Orders"
  service payments "Payments"
  service notifications "Notifications"
}

db main_db "Main DB" [Postgres]
external psp "Payment Provider"
external smtp "Email Provider"

web -> edge: HTTPS
edge -> orders
orders -> payments: charge
orders -> notifications: send receipt
orders -> main_db
payments -> main_db
payments -> psp: REST
notifications -> smtp

---

## Starting point

One deployable and one database. Simple to build and to run, but:

- a slow email provider makes **checkout** slow, because the receipt is sent inside the request
- payments can't scale on their own
`;

const V2 = `# Orders platform, v2: split services, notifications go async
direction down

client web "Web App"
gateway api "API Gateway"

group orders_ctx "Orders" {
  service orders "Orders API"
  db orders_db "Orders DB" [Postgres]
}

group payments_ctx "Payments" {
  service payments "Payments"
  db payments_db "Payments DB"
}

topic order_events "order.events"
worker notifications "Notifications"
external psp "Payment Provider"
external smtp "Email Provider"

web -> api: HTTPS
api -> orders: POST /orders
orders -> orders_db
orders -> payments: charge
payments -> payments_db
payments -> psp: REST
orders --> order_events: OrderPlaced
order_events --> notifications
notifications -> smtp

---

## Why split

- Orders and Payments deploy and scale independently
- Email is an event now: checkout no longer waits for SMTP

## Problem found

\`orders\` writes to its database **and** publishes the event. If the publish
fails after the commit, the event is lost (a *dual write*). Fixed in v3.
`;

const NOW = `# Orders platform, v3: outbox + async payments
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

---

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
`;

export const EXAMPLE_DOCUMENT = {
  text: NOW,
  snapshots: [
    { id: 'seed-v1', name: 'v1 monolith', text: V1, createdAt: '2026-11-01T14:00:00.000Z' },
    { id: 'seed-v2', name: 'v2 events', text: V2, createdAt: '2026-11-04T18:30:00.000Z' },
  ],
};
