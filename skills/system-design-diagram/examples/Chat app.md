---
archslate: diagram
---

```archslate
# Chat app
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
```

## Requirements

- 1:1 and group chats, delivered in order per chat
- Delivered when the recipient comes back online
- Online indicators within a few seconds

## Trade-offs

- Gateways hold the sockets; the chat service stays stateless and scales on its own.
- Ordering comes from the stream's partition key (`chat_id`), not from the clients' clocks.
- Store first, then publish: a crash between the two delays delivery until the recipient syncs. An outbox
  would close that gap.
- Online indicators: presence tells the gateways who came and went, and they tell the phones.
