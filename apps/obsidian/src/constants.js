// The plugin's names in one module. `id` and `name` come from the repository's
// manifest.json (read at build time); everything else follows from them.
//
// Changing `id` later moves the plugin's data folder and renames its view
// type: open tabs come back as Markdown until they are opened as diagrams again.

import manifest from '../../../manifest.json';
import { FLAG_KEY, FLAG_VALUE, LANGUAGE } from '../../../packages/core/document.js';

/** Its folder under <vault>/.obsidian/plugins/ and the prefix of its commands. */
export const PLUGIN_ID = manifest.id;
/** The name Obsidian shows (settings, the command palette). */
export const PLUGIN_NAME = manifest.name;
/** The view type of a diagram tab (workspace.json keeps it for open tabs). */
export const VIEW_TYPE = PLUGIN_ID;
/** The class on the view's content element: the scope of the plugin's own styles. */
export const VIEW_CLASS = 'archslate-view';
/** The Lucide icon of the view, the ribbon button and the menu items. */
export const ICON = 'workflow';
/** A new diagram's file name: `Untitled diagram.md`, `Untitled diagram 1.md`, ... */
export const NEW_DIAGRAM_NAME = 'Untitled diagram';
/** `archslate: diagram` in a note's properties makes it open as a diagram. */
export { FLAG_KEY, FLAG_VALUE, LANGUAGE };

/** What a new diagram starts with. */
export const STARTER = `direction down

client web "Web app"
gateway api "API gateway"
service app "App service"
db store "Database"

web -> api: HTTPS
api -> app
app -> store
---

## Notes

Write requirements, estimates and trade-offs here: this part is plain Markdown.
`;

/** What "Insert diagram" puts in a note. */
export const BLOCK_TEMPLATE = `\`\`\`${LANGUAGE}
direction right
client web "Web app"
service api "API"
db store "Database"
web -> api: HTTPS
api -> store
\`\`\`
`;
