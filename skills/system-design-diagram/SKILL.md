---
name: system-design-diagram
description: Writes system design diagrams as Markdown notes that Archslate draws (in Obsidian with the Archslate plugin, and in the Archslate web app) and that read as an ordinary note with a code block anywhere else. A small line-based language declares components (services, databases, queues, caches, ...), request, event and connection links, groups, sticky notes, instance counts, details such as QPS, numbered flows, and free Markdown notes below the diagram; a bundled CLI validates a note, writes a new one, replaces its diagram safely and saves named versions. Use when the user asks for a system design, an architecture or infrastructure diagram, a data flow, an interview-style design (URL shortener, chat, feed, rate limiter, ...), or wants an existing Archslate diagram read, checked, extended or versioned.
---

# System design diagrams (Archslate)

A diagram is ONE Markdown note: a `archslate: diagram` property, an ```` ```archslate ```` code block with the
diagram's source, then ordinary Markdown (requirements, estimates, trade-offs). Archslate (the Obsidian plugin and
the web app) draws the block as a diagram and lets the user edit it from text or by clicking. Elsewhere (GitHub,
another editor) it reads as a note with a code block. Saved versions sit in a comment at the end of the note.

`scripts/`, `reference/` and `examples/` are in this skill's folder (`<skill folder>` below: the folder that holds
this SKILL.md). Many agent tools start a new shell for every command, so begin every command that runs the CLI by
setting its full path, then call it as `node "${AS:?}"`, for example
`AS="$HOME/.claude/skills/system-design-diagram/scripts/archslate.mjs"; node "${AS:?}" validate "/path/to/vault/URL shortener.md"`
(use the real folder). With `AS` empty, `${AS:?}` stops the command with a message instead of running nothing.
Give notes by their full path; never `cd` into the skill folder or write notes there. Node 18 or later.

## 30-second example

The user asks for "a URL shortener design in my vault". Hand the source to the CLI on standard input (no file to
leave behind), then check the note:

```bash
AS="$HOME/.claude/skills/system-design-diagram/scripts/archslate.mjs"
node "${AS:?}" new "/path/to/vault/URL shortener.md" --from - <<'SRC'
# URL shortener
direction down

client web "Browser"
lb edge "Load balancer"
service api "Shortener API" x3 [stateless]
cache hot "Hot links" [Redis, LRU]
db links "Links" [Cassandra, key: short code]

web -> edge: GET /abc123
edge -> api
api -> hot: lookup
api -> links: on miss

flow redirect "Follow a short link" {
  web -> edge
  edge -> api
  api -> hot: cached? answer 302 at once
  api -> links: not cached: read, then fill the cache
}
---

## Requirements
- Redirect in under 20 ms (p99) for a cached link
SRC
AS="$HOME/.claude/skills/system-design-diagram/scripts/archslate.mjs"
node "${AS:?}" validate "/path/to/vault/URL shortener.md"
```

`new` refuses source with problems (or with nothing to draw) and writes nothing, and it never replaces a file that
exists; `validate` prints the outline the diagram will show, then `ok: no problems` or each problem with the
note's own line number.

## Workflow

1. **Understand the system** the user wants: its clients, the request path, where data lives, what is
   asynchronous, what scales out. Ask only when the purpose is unclear; otherwise make reasonable choices and say
   which ones.
2. **Write the source** (the language is below; every rule is in `reference/FORMAT.md`). Declare every component
   before linking it: a link to an undeclared name is an error, never a new box.
3. **Create or change the note with the CLI**, never by hand-editing a note that already has versions:
   - a new diagram: `new <note> --from -` with the source on standard input (or `--from <file>`). If the note
     exists, `new` refuses: change it with `set`, or pick another name. Never delete or overwrite a user's note.
   - an existing one: `set <note> --from -` replaces the diagram and keeps the note's properties, the text before
     the block and every saved version. The Markdown below the block (the notes) is kept when your source has no
     `---` section; when it has one, it REPLACES the notes, and the CLI says how many lines it replaced. To keep
     the user's notes, start from `source <note>` (it prints the notes too) or leave `---` out.
   - before a big change the user may want to compare against, `version <note> --name "<what it was>"` saves the
     current diagram as a version (Archslate's **Changes** view then shows what changed).
4. **Validate** (`validate <note>`) and fix every problem before you answer.
5. **Tell the user** where the note is and what it shows. In a vault where Archslate is installed and enabled the
   note opens as a diagram; if it is installed but off, tell them to enable it in Settings > Community plugins; if
   it is not installed, the note still reads fine and the web app at https://wilsonneto-swe.github.io/archslate-obsidian/ can
   open it (Open…).

## The language, in short

```text
direction down                               # or right (the default)

client web "Web app"                         # <type> <id> ["Label"] [xN] [[details]]
gateway api "API gateway" [auth, rate limits]
service orders "Orders" x3 [stateless]       # x3: three identical copies, xN: many
db orders_db "Orders DB" [Postgres, sharded by user_id]

group payments "Payments" {                  # a box around components; groups nest
  worker charge "Charger" x2
  queue retries "retry.queue"
}

note orders_db "Order and outbox rows commit together"   # sticky note beside a component

web -> api: HTTPS [10k QPS]                  # ->  request / response (the caller points at the callee)
api -> orders: POST /orders
orders --> charge: OrderPlaced               # --> event, asynchronous (points the way the data goes)
charge --> retries: failed charge
web <-> api: WebSocket                       # <-> open two-way connection

flow checkout "Place an order" {             # numbered walkthrough over links declared above
  web -> api: submit
  api -> orders
}
---
Everything below a line with only `---` is Markdown notes.
```

Types: `client` `mobile` `user` `dns` `cdn` `lb` `gateway` `ratelimiter` (edge), `service` `worker` `function`
`cron` (compute), `db` `cache` `storage` `search` `warehouse` `coordinator` (data), `queue` `topic` `stream`
(messaging), `external`. Ids are letters, digits, `_`, `-`, `.`; one declaration per line; `#` or `//` start a
comment (also in a link label, after a space: quote a label like `"retry #1"`).

## What makes a good diagram

- **Tell one story.** 6 to 15 components; split a bigger system into notes (one per subsystem) and say so.
- **Name things by role** ("Orders API", "Payments DB"), and put technology, numbers and guarantees in
  `[details]` (`[Postgres, 2 read replicas]`, `[10k QPS, p99 < 50 ms]`, `[at-least-once]`), not in labels.
- **Pick the arrow by meaning**: a request when the caller waits for an answer, an event when it does not, a
  connection for sockets and streams. Arrows follow the message that starts the interaction.
- **Show scale where it matters**: `x3` or `xN` on stateless services and workers; replicas and shards as details
  of the database.
- **Group by ownership or boundary** (a bounded context, a region, a VPC), not by technology.
- **Add a flow for each question the design answers** ("place an order", "read path"), with the step text saying
  what happens. Flows only walk links that exist; a connection can be walked both ways.
- **Notes for decisions**: a sticky `note` for something about one component; requirements, estimates and
  trade-offs go below `---` as Markdown (tables work).
- Keep the source tidy: declarations first (groups in their blocks), then links, then flows.

## Reading and changing an existing diagram

- `source <note>` prints the diagram's source (with its notes after `---`); edit that text and give it back with
  `set`. Keep ids stable: the versions and the **Changes** view match components by id, so renaming an id reads as
  one component removed and another added. Change the label instead.
- Never edit the `%% archslate:versions` block at the end of a note; the CLI and the app manage it.
- `validate` after every change.

## Problems you may see

| Message | Fix |
| --- | --- |
| `Unknown component "x"` | Declare `x` first, or fix the typo. |
| `"x" is already declared` | Ids are unique across components and groups. |
| `Unknown type "servce"` | Use one of the types above. |
| `Labels must be quoted` | `service api "Orders API"`, not `service api Orders API`. |
| `One link per line` | `a -> b -> c` is two lines: `a -> b` and `b -> c`. |
| `No link from a to b` (in a flow) | Flows walk declared links; add the link above the flow. |
| `Group "g" is never closed` | Add the `}` (a `---` line ends the diagram). |

`reference/FORMAT.md` has every rule; `examples/` has complete notes.
