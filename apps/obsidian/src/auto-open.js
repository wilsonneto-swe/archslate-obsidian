// AUTO-OPEN: a note with the flag (`archslate: diagram`) opens as a diagram
// wherever Obsidian opens it in a tab: the file explorer, a link, the quick
// switcher, search, back and forward. Obsidian asks a leaf for a Markdown view
// (WorkspaceLeaf.setViewState with type `markdown`); the plugin's patch asks
// this module whether to hand it the diagram view instead. It does when:
//  - the request is for a Markdown view of a `.md` file,
//  - the workspace is ready and the tab is not being restored (while Obsidian
//    restores the saved layout, and when a background tab it restored is first
//    shown, every tab keeps the type it was saved with),
//  - the user did not choose Markdown for that note in that tab ("Open as
//    Markdown" sticks for as long as the tab lives),
//  - and the note carries the flag.
// Hover previews and embeds are not tabs: they keep showing the Markdown, where
// the code block draws the diagram anyway.

/** @typedef {import('../../../packages/types').OpenChoice} Choice */

/**
 * @param {import('../../../packages/types').OpenRequest} request
 * @returns {boolean}
 */
export function opensAsDiagram({ type, path, layoutReady, restoring = false, choice, flagged }) {
  if (type !== 'markdown' || path === null || !path.toLowerCase().endsWith('.md') || !layoutReady || restoring || !flagged) return false;
  return choice !== 'markdown';
}

/**
 * The path something keyed by `path` moves to when `oldPath` is renamed (a folder moves everything inside).
 * @param {string} path
 * @param {string} oldPath
 * @param {string} newPath
 * @returns {string | null} null when the rename does not move it
 */
export function renamedPath(path, oldPath, newPath) {
  if (path === oldPath) return newPath;
  if (path.startsWith(`${oldPath}/`)) return newPath + path.slice(oldPath.length);
  return null;
}

/**
 * `Untitled diagram`, then `Untitled diagram 1`, ... whichever is free.
 * @param {(name: string) => boolean} taken
 * @param {string} base
 * @returns {string}
 */
export function untitledName(taken, base) {
  if (!taken(base)) return base;
  for (let n = 1; ; n += 1) if (!taken(`${base} ${n}`)) return `${base} ${n}`;
}
