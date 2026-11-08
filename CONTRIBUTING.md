# Contributing to Archslate

Thanks for helping. This repository holds the Obsidian plugin and the web version of Archslate; they share one
editor, so most changes reach both.

## Questions and ideas

Ask in [Discussions](https://github.com/wilsonneto-swe/archslate-obsidian/discussions): **Q&A** for how-to
questions, **Ideas** for things Archslate could do. A feature request is easier to act on when it shows the diagram
or the question you were working on.

## Reporting a bug

[Open an issue](https://github.com/wilsonneto-swe/archslate-obsidian/issues/new/choose) with:

- the Archslate and Obsidian versions (or "web"), and your platform;
- the steps, and the smallest diagram source that shows the problem (leave out anything private);
- what you expected and what happened;
- any red lines that mention Archslate in the developer console (View > Toggle Developer Tools > Console).

## Building and testing

You need Node.js 22 or later.

```
npm install
npm run check          # Obsidian's lint rules (with types), both builds, the unit tests, a scan for private data
npm run dev            # the web version from the sources: http://localhost:5173/apps/web/
npm run test:e2e       # the built web page in Chrome, the plugin in the real Obsidian app (macOS; see docs/DEVELOPMENT.md)
```

Try the plugin in a **test vault**, not the vault you use every day:
`npm run build:obsidian -- --watch --vault "<path to the test vault>"` rebuilds on every change and copies
`main.js`, `manifest.json` and `styles.css` into its `.obsidian/plugins/archslate/` folder; reload Obsidian and
enable the plugin. The end-to-end tests start Obsidian on a throwaway profile and vault of their own, never yours
([docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)).

## Where things are

| Folder | What it holds |
| --- | --- |
| `apps/obsidian/src` | The plugin: the view (`view.js`), commands, menus, auto-open and code block drawing (`main.js`) |
| `apps/web` | The web version: the page, its storage, open and save |
| `packages/core` | The language (`parser.js`), canvas edits as text edits (`edits.js`), layout and link routing, the versions diff, the note format (`document.js`) |
| `packages/ui` | The editor: canvas, source pane, versions strip, notes panel, export, styles |
| `test`, `apps/obsidian/test` | Unit tests (`npm test`) |
| `e2e` | End-to-end tests (`npm run test:e2e`) |
| `examples` | Example diagrams |
| `skills`, `tools` | The agent skill and its command-line tool (not part of the plugin) |
| `docs` | Architecture, development, releasing |

Two rules hold everywhere: the text is the only source of truth (the canvas never keeps its own state; every action
is a text edit), and no `innerHTML`: text reaches the page through `textContent` only.

## Sending a pull request

- Keep it focused: one fix or feature per pull request.
- Add or update a test when behaviour changes, and run `npm run check`.
- Describe what changes for someone using Archslate, and how you tried it (in Obsidian, on the web, or both).
