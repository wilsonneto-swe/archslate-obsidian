# apps/obsidian: the Obsidian plugin

The plugin hosts the editor from `packages/ui` in an Obsidian view and connects it to Obsidian. The repository's
root holds what Obsidian's community directory reads: `manifest.json`, `versions.json`, `README.md` (the user guide)
and `LICENSE`; releases attach the build from `dist/`.

| Path | What it is |
| --- | --- |
| `src/main.js` | The plugin: view registration, the `setViewState` patch (auto-open), commands, menus, ribbon, code block drawing, exports |
| `src/view.js` | `DiagramView`, a `TextFileView` over a Markdown note; keeps the note around the diagram (`packages/core/document.js`) |
| `src/auto-open.js`, `src/patch.js`, `src/view-state.js` | Pure helpers, unit-tested in `test/` |
| `src/styles.css` | The plugin's own styles, appended to the editor's |
| `test/` | Unit tests, and a test that loads the built bundle against a stand-in `obsidian` module |

```
npm run build:obsidian                       # dist/: main.js, manifest.json, styles.css
npm run build:obsidian -- --watch --vault "<test vault>"
npm run test:e2e                             # in the real Obsidian app, isolated (docs/DEVELOPMENT.md)
```
