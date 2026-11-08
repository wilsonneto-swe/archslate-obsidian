# Architecture

Archslate is one core and two shells. Everything a diagram is lives in plain JavaScript modules with no runtime
dependencies: the parser, the layout, the link router and the SVG renderer are written from scratch.

```
packages/
  core/                pure logic, no DOM: runs in Node, the browser and Obsidian
    parser.js          text -> model; every item remembers its line and token offsets
    edits.js           canvas actions as text -> text edits
    layout.js          layered layout with nested groups (a simplified Sugiyama)
    routing.js         orthogonal A* link router: links never cross components
    diff.js            two models compared; the union model of the Changes view
    flows.js           the numbered walkthrough view of one flow
    document.js        the note format: the block, the notes, the versions comment
    kinds.js           component types and link operators
  ui/                  the editor, DOM only, host-agnostic
    editor.js          DiagramEditor: the text, its history, the versions, the view state
    canvas.js          pan and zoom, selection, (+) handles, toolbars, popovers, keys
    renderer.js        model + layout -> SVG (keyed, animated)
    code-pane.js       a textarea over a highlighted mirror
    timeline.js        the versions strip
    notes-panel.js     the Markdown below the diagram, rendered
    markdown.js        a small Markdown renderer for the web (DOM nodes, no innerHTML)
    export.js          PNG and SVG with the theme's computed styles inlined
    embed.js           a read-only drawing (Obsidian's code blocks)
apps/
  obsidian/            the plugin: a TextFileView, commands, menus, auto-open, code blocks
  web/                 the web page: localStorage, open, save, drag and drop
tools/archslate-cli/   the agent skill's command-line tool (built into skills/)
```

## Text is the only source of truth

```
text -> parse -> [diff against a version | a flow's view] -> layout -> route -> SVG
  ^                                                                         |
  +---------------- edits.js (click, (+), rename, delete, details) ---------+
```

The canvas never holds diagram state. Every action calls a function in `edits.js`, which rewrites the lines it
affects and leaves everything else (comments, spacing, order) untouched; the result is parsed and drawn like any
typed change. That is why the canvas and the source can never disagree, and why undo is a plain text history.

Rules that keep it that way:

- **Strict references.** A link, note or flow step naming an unknown component is an error at its line, never a new
  component. Errors never stop the drawing: the bad line is skipped.
- **One declaration per line.** Canvas edits insert, rewrite or delete whole lines.
- **Identity is the id.** The diff, the selection and the view state follow ids; labels are free to change.

## The note around the diagram

`document.js` reads a note into `{ text, snapshots }` plus an *envelope*: the frontmatter, any text before the block,
the block's fence and indent, the line endings, a BOM, and the exact original. The block is the first `archslate`
fence at the note's top level: the reader skips other code blocks and `%%` / `<!-- -->` comments, so an example or a
commented-out diagram is never mistaken for it. Writing back puts the envelope around the new block; when nothing
changed it returns the original bytes, so opening a note never rewrites it. Versions are JSON lines in a
`%% archslate:versions` comment at the end of the note; lines written by hand stay as they are until the versions
change, and text added after the comment is read as notes.

Saving: the editor saves 400 ms after a change, and at once for version actions. In Obsidian that asks for the
view's debounced save, and closing the view writes whatever is still pending (`onClose` runs `FileView`'s close,
which saves, before the editor is taken down). On the web, each write carries a revision: tabs follow each other's
writes through the `storage` event, and a tab never writes over a newer revision it has not seen.

## Layout and routing

`layout.js` assigns layers (longest path, then slack used to shorten links and keep groups compact), treats each
group as a rigid block stacked by layer span (so groups never overlap or swallow a stranger), orders blocks by
barycenter sweeps scored on crossings, and relaxes positions toward linked neighbours. Sticky notes ride along beside
their component inside its unit. `routing.js` routes each link with A* over a sparse orthogonal grid: components are
hard obstacles; bends, crossings, overlaps and cutting through foreign groups are costs.

## Hosts

A shell gives the editor a host:

```js
host.load()      // -> Promise<{ text, snapshots: [{ id, name, text, createdAt }] }>
host.save(doc)   // called 400 ms after a text change, at once for version actions

// optional
host.renderMarkdown(markdown, element)   // Obsidian's own renderer in the plugin
host.saveFile(filename, blob)            // where exports go (default: a download)
host.fileName()                          // the base name of exported files
host.notify(message, { error })          // a notice (default: a toast)
host.serializeDocument(doc)              // the note for "Diagram note (.md)"
host.exportsDocument                     // false where the note already is the file
host.appleKeys                           // true to label shortcuts ⌘S rather than Ctrl+S
```
