# Archslate format reference

## The note

````markdown
---
archslate: diagram
---

```archslate
<the diagram's source>
```

<notes: ordinary Markdown>

%% archslate:versions
{"name":"v1","createdAt":"2026-11-07T12:00:00.000Z","id":"v1","text":"<the source then>"}
%%
````

That is how the CLI writes it: the property, a blank line, the code block, then the notes as ordinary Markdown
after the block. Precisely:

- **The property** `archslate: diagram` (in the note's frontmatter) makes the note open as a diagram in Obsidian
  with the plugin. Other properties are kept as they are.
- **The block** is the first fenced code block whose language is `archslate` (```` ``` ```` or `~~~`, three or
  more) at the note's top level: one inside another code block, a `%%` or `<!-- -->` comment, a callout or a list
  is only text (an example, an old diagram). It may be indented up to three spaces. Its content is the diagram's
  source. Text before the block stays where it is.
- **The notes** are everything after the block. In the editor they show below a `---` line of the source and in a
  rendered panel; in the note they are plain Markdown.
- **Versions** are kept in a comment at the end of the note, one JSON object per line:
  `%% archslate:versions`, then `{"name":…,"createdAt":…,"id":…,"text":…}` lines, then `%%`. `%` inside them is
  written as `\u0025` (a JSON escape), so nothing can close the comment early. Do not edit it by hand. Text added
  after the comment (a footnote, a line another tool appended) is read as notes, and the next save puts the
  comment back at the end.

A note opened and not changed is never rewritten. An edit rewrites the block (and the versions comment when a
version is saved); the properties and the text around the block stay, and so do the line endings (a note with any
CRLF line ending is written with CRLF throughout). Blank lines at the very end of the note are not kept.

## Lines

One declaration per line. Blank lines are fine anywhere. `#` or `//` start a comment at the start of a line or after
a space, also inside a link's label: `a -> b: retry #1` loses `#1`. Quote such a label to keep it whole
(`a -> b: "retry #1"`). `http://x` and `step#1` are fine: no space before the `//` or the `#`.

### Direction

`direction down` (top to bottom) or `direction right` (left to right, the default). One per diagram.

### Components

```
<type> <id> ["Label"] [x<N> | xN] [[detail, detail, ...]]
```

- **Types**: `client`, `mobile`, `user`, `dns`, `cdn`, `lb`, `gateway`, `ratelimiter`, `service`, `worker`,
  `function`, `cron`, `db`, `cache`, `storage`, `search`, `warehouse`, `coordinator`, `queue`, `topic`, `stream`,
  `external`. Aliases: `database` (db), `bucket` (storage), `consumer` (worker), `lambda` (function), `browser`
  (client), `scheduler` (cron), `loadbalancer` (lb), `thirdparty` (external), `ratelimit` and `limiter`
  (ratelimiter), `olap`, `datalake` and `lake` (warehouse), `coordination` and `consensus` (coordinator).
- **Id**: letters (any script, with their accents and marks), digits, `_`, `-`, `.`. Unique across components and
  groups. Links, notes and flows refer to it.
- **Label**: double quotes, `\"` for a quote inside. Without one, the id is shown.
- **Instances**: `x2`, `x10` ... or `xN` for "many": drawn as a stack. `x1` means one: a single card, the same as
  writing no count.
- **Details**: square brackets, comma separated: technology, numbers, guarantees. Shown under the label.
- Label, instances and details may come in any order after the id.

### Groups

```
group <id> ["Title"] {
  <components, groups, and the notes and links that belong with them>
}
```

A box around its members; groups nest. A group needs an id or a title. A title alone makes the id from it (`group
"Orders" {` is `orders`, or `orders_2` when a component is already called `orders`); give an id when links or other
tools need a name that never changes. Indentation is free but two spaces per level read best. Links cannot point at
a group, only at components in it.

### Links

```
<from> -> <to>[: label] [[details]]     request / response: the caller points at the callee
<from> --> <to>[: label] [[details]]    event, asynchronous: points the way the data goes
<from> <-> <to>[: label] [[details]]    an open two-way connection (WebSocket, SSE, a stream)
```

`=>` is accepted as `-->` (older notes). Both ends must be declared components. One link per line. The label runs to
the end of the line; trailing `[...]` is the link's details (put the label in quotes if it ends with `]`).
Details may also come before the colon, which is where the editor writes them: `a -> b [async]: retry`.

### Notes

```
note <component id> "text"
```

A sticky note beside the component (several notes on one component stack up). Notes attach to components, not
groups.

### Flows

```
flow <id> ["Title"] {
  <from> <op> <to>[: what happens in this step]
  ...
}
```

A numbered walkthrough: each line is a step over a link declared elsewhere (`from` and `to` as declared; a
connection `<->` may be walked in either direction). The step's text replaces the link's label while the flow is
shown; steps are numbered 1, 2, 3... in order, and a step that walks no link gets no number. Like a group, a flow
needs an id or a title (`flow "Checkout" {` makes the id `checkout`). Only steps go inside a flow; flows go at the
top level, outside groups.

### The notes section

A line with only `---` ends the diagram: everything after it is Markdown notes and is not parsed.

## Errors

A line with a problem is skipped, or drawn as far as it could be read (an unclosed quote, a stray character), and
the rest of the diagram still draws. Every message:

- `Unknown type "x". Types: ...`
- `Expected a declaration`, `Expected a name after "x"`, `Expected a name before the arrow`,
  `Expected a name after the arrow`, `Expected a component name after "note"`
- `Labels must be quoted, for example: service api "Orders API"`
- `Unexpected text. After the name: an optional "Label", x3 and [details]`
- `Use x1 or more, or xN for "many"`, `That number is too large. Use xN for "many"`
- `"x" is already declared`, `Flow "x" is already declared`
- `Unknown component "x"`, `"x" is a group. Link to a component inside it`
- `One link per line. Split this into two lines`, `Use ":" before the link label`, `Unexpected text after the link label`
- `Missing closing quote`, `Missing closing "]"`, `Unexpected character "x"`
- `Expected "{" to open the group` (or `the flow`), `Unexpected text after "{"`, `Unexpected text after "}"`,
  `A group needs a name, for example: ...` (or `A flow needs a name, ...`)
- `This "}" does not close any group`, `Group "x" is never closed`, `Flow "x" is never closed`,
  `Groups nest at most 40 deep`
- `Notes attach to components, not groups`, `Note text must be quoted, ...`, `Unexpected text after the note`
- `Flows go at the top level, outside groups`, `Only links go inside a flow, ...`
- `No link from a to b. Flows walk links declared above`, `The link goes from b to a, not the other way`
- `Details belong on the link declaration, not on a flow step`
- `Direction must be "right" or "down"`
