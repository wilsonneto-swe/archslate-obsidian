// The plugin in the real Obsidian app (e2e/helpers/obsidian.mjs: an isolated
// profile and vault, never yours). Needs `npm run build:obsidian`, Obsidian
// installed, and your own Obsidian closed; skipped otherwise.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sleep } from './helpers/cdp.mjs';
import { ObsidianApp, unavailable } from './helpers/obsidian.mjs';
import { serializeNewNote } from '../packages/core/document.js';

const example = (name) => readFileSync(new URL(`../examples/${name}.md`, import.meta.url), 'utf8');
const why = unavailable();

describe('Archslate in Obsidian', { skip: why ?? false }, () => {
  let app;
  let page;
  const editor = (expr) => page.eval(`(() => { const v = app.workspace.getLeavesOfType('archslate')[0]?.view; const e = v?.editor; return ${expr}; })()`);
  // Rests the mouse on an element (Obsidian's tooltips start on pointerover) and returns the tooltips
  // shown, then moves it away again. An error in Obsidian's tooltip code fails the suite (after()).
  // A MouseEvent, not a PointerEvent: Obsidian takes pointer events for touch until a real mouse has moved.
  const hover = async (target) => {
    const at = (type) => `(() => { const t = ${target}; const W = t.ownerDocument.defaultView; const r = t.getBoundingClientRect(); t.dispatchEvent(new W.MouseEvent('${type}', { bubbles: true, clientX: r.x + 4, clientY: r.y + 4 })); return [...t.ownerDocument.querySelectorAll('.tooltip')].map((x) => x.textContent); })()`;
    await page.eval(at('pointerover'));
    await sleep(1300);
    const shown = await page.eval(at('pointerout'));
    await sleep(300);
    return shown;
  };

  before(async () => {
    app = await ObsidianApp.launch({
      size: { width: 1300, height: 860 },
      files: {
        'Orders platform.md': example('Orders platform'),
        'D.md': serializeNewNote({ text: 'service a\nservice b\nservice c\na -> b\n', snapshots: [] }),
        'Study notes.md': '# Caching\n\n```archslate\nclient web\nservice api\ncache c\nweb -> api\napi -> c\n```\n\nThat is all.\n',
        'Plain.md': '# Plain\n\ntext\n',
      },
    });
    page = app.page;
  });
  after(async () => {
    const errors = page?.logs.filter((l) => /\[exception\]|\[console\.error\]/.test(l)) ?? [];
    await app?.close();
    assert.deepEqual(errors, [], 'no errors in the console');
  });

  test('a flagged note opens as a diagram, and opening never writes it', async () => {
    const before = app.read('Orders platform.md');
    await app.openNote('Orders platform.md');
    await page.waitFor(`app.workspace.getMostRecentLeaf()?.view?.getViewType() === 'archslate'`);
    assert.equal(await page.eval(`document.querySelectorAll('.workspace-leaf.mod-active .sd-node').length`), 12);
    await sleep(2500);
    assert.equal(app.read('Orders platform.md'), before);
  });

  test('no tooltip follows the pointer over the canvas or the source; buttons keep theirs', async () => {
    const root = `app.workspace.getLeavesOfType('archslate')[0].view.editor.root`;
    assert.deepEqual(await hover(`${root}.querySelector('.sd-node')`), []);
    assert.deepEqual(await hover(`${root}.querySelector('.sd-code-input')`), []);
    assert.deepEqual(await hover(`${root}.querySelector('.sd-timeline')`), []);
    assert.deepEqual(await hover(`${root}.querySelector('.sd-zoombar .sd-btn')`), ['Zoom out (-)']);
  });

  test('an edit is saved into the note, and only the block changes', async () => {
    const before = app.read('Orders platform.md');
    await editor(`(e.commit({ text: e.text.replace('worker payments "Payments" x2', 'worker payments "Payments" x4') }), 1)`);
    await sleep(3000);
    assert.equal(app.read('Orders platform.md'), before.replace('worker payments "Payments" x2', 'worker payments "Payments" x4'));
  });

  test('a change on disk reloads the diagram, and undo brings back ours', async () => {
    const now = app.read('Orders platform.md');
    app.write('Orders platform.md', now.replace('"Payments" x4', '"Payments" x9'));
    await page.waitFor(`app.workspace.getLeavesOfType('archslate')[0].view.editor.text.includes('x9')`);
    await editor('(e.undo(), 1)');
    assert.ok(await editor(`e.text.includes('"Payments" x4')`));
  });

  test('keys: one Mod+Z is one undo, Mod+S opens "Save version", Delete deletes', async () => {
    await app.openNote('D.md');
    await page.waitFor(`app.workspace.getMostRecentLeaf()?.view?.editor?.text?.includes('service c')`);
    const active = (expr) => page.eval(`(() => { const e = app.workspace.getMostRecentLeaf().view.editor; return ${expr}; })()`);
    await active(`(e.commit({ text: e.text + 'service d\\n' }), e.commit({ text: e.text + 'service e\\n' }), e.canvas.focus(), 1)`);
    await page.key('z', 4);
    assert.equal(await active('e.text'), 'service a\nservice b\nservice c\na -> b\nservice d\n');
    await page.key('z', 12);
    assert.ok((await active('e.text')).endsWith('service e\n'));
    await page.key('s', 4);
    await sleep(200);
    assert.ok(await page.eval(`!!document.activeElement?.closest('.sd-tl-form')`));
    await page.key('Escape');
    await active(`(e.select({ type: 'node', id: 'c' }), e.canvas.focus(), 1)`);
    await page.key('Delete');
    assert.ok(!(await active('e.text')).includes('service c'));
  });

  test('a code block is drawn in a note, and the note opens as a diagram on demand', async () => {
    await app.openNote('Study notes.md');
    assert.equal(await app.activeType(), 'markdown');
    await page.waitFor(`document.querySelectorAll('.workspace-leaf.mod-active .sd-embed svg .sd-node').length >= 3`);
    await page.waitFor(`!!document.querySelector('.workspace-leaf.mod-active .sd-embed .archslate-open')`, { what: 'the block\'s open button' });
    assert.deepEqual(await hover(`document.querySelector('.workspace-leaf.mod-active .sd-embed svg .sd-node')`), []);
    assert.ok(await app.command('archslate:open-as-diagram'));
    await page.waitFor(`!!app.workspace.getMostRecentLeaf()?.view?.editor?.model`);
    assert.ok(await page.eval(`app.workspace.getMostRecentLeaf().view.editor.model.markdown.includes('That is all.')`));
    assert.ok(await app.command('archslate:open-as-markdown'));
    await page.waitFor(`app.workspace.getMostRecentLeaf()?.view?.getViewType() === 'markdown'`);
  });

  test('"Always open as diagram" sets the flag, "Stop..." takes it out; "New diagram" makes a flagged note', async () => {
    await app.openNote('Plain.md');
    // The palette offers only the command that changes something.
    const offered = (id) => page.eval(`!!app.commands.findCommand(${JSON.stringify(id)})?.checkCallback(true)`);
    assert.equal(await offered('archslate:stop-always-open-as-diagram'), false, 'nothing to stop yet');
    assert.ok(await app.command('archslate:always-open-as-diagram'));
    await page.waitFor(`app.workspace.getMostRecentLeaf()?.view?.getViewType() === 'archslate'`);
    assert.equal(app.read('Plain.md'), '---\narchslate: diagram\n---\n# Plain\n\ntext\n');
    await page.waitFor(`app.metadataCache.getCache('Plain.md')?.frontmatter?.archslate === 'diagram'`);
    assert.equal(await offered('archslate:always-open-as-diagram'), false, 'already on');
    assert.ok(await app.command('archslate:stop-always-open-as-diagram'));
    await page.waitFor(`!app.metadataCache.getCache('Plain.md')?.frontmatter?.archslate`);
    assert.ok(!app.read('Plain.md').includes('archslate: diagram'));
    assert.ok(app.read('Plain.md').includes('# Plain\n\ntext\n'));
    assert.ok(await app.command('archslate:new-diagram'));
    await page.waitFor(`!!app.vault.getAbstractFileByPath('Untitled diagram.md')`);
    assert.ok(app.read('Untitled diagram.md').startsWith('---\narchslate: diagram\n---\n\n```archslate\n'));
  });

  test('closing the tab right after an edit still writes the edit', async () => {
    await app.openNote('D.md');
    await page.waitFor(`app.workspace.getMostRecentLeaf()?.view?.editor?.text?.includes('service a')`);
    await page.eval(`(() => { const leaf = app.workspace.getMostRecentLeaf(); const e = leaf.view.editor; e.commit({ text: e.text + 'cache closing\\n' }, { source: 'code' }); leaf.detach(); })()`);
    await sleep(800);
    assert.ok(app.read('D.md').includes('cache closing\n'));
  });

  test('a diagram moved into a pop-out window keeps working there', async () => {
    await app.openNote('D.md');
    await page.waitFor(`app.workspace.getMostRecentLeaf()?.view?.editor?.text?.includes('service a')`);
    await page.eval(`(() => { const leaf = app.workspace.getMostRecentLeaf(); window.__popLeaf = leaf; app.workspace.moveLeafToPopout(leaf); return 1; })()`);
    await page.waitFor(`(() => { const v = __popLeaf.view; return !!v?.editor && v.containerEl.ownerDocument !== document && v.containerEl.isConnected; })()`, { timeout: 15_000, what: 'the diagram in a pop-out window' });
    const pop = (expr) => page.eval(`(() => { const v = __popLeaf.view; const e = v.editor; const W = v.containerEl.ownerDocument.defaultView; return ${expr}; })()`);
    // The editor observes from its new window.
    await page.waitFor(`__popLeaf.view.editor.watched === __popLeaf.view.containerEl.ownerDocument.defaultView`, { what: 'the editor following it into the pop-out' });
    // Typing in the pop-out redraws the canvas there.
    await pop(`(e.commit({ text: e.text + 'service popped\\n---\\nSee [[Plain]]\\n' }, { source: 'code' }), 1)`);
    await page.waitFor(`!!__popLeaf.view.editor.root.querySelector('[data-node="popped"]')`, { what: 'the new component drawn in the pop-out' });
    // Elements made for the pop-out are real elements, never text like "[object HTMLSpanElement]".
    await pop(`(e.select({ type: 'node', id: 'popped' }), e.canvas.openKindPicker('popped'), 1)`);
    const broken = await pop(`(() => { const walker = e.root.ownerDocument.createTreeWalker(e.root, 4); const hits = []; let n; while ((n = walker.nextNode())) if (/\\[object \\w+\\]/.test(n.data)) hits.push(n.data.slice(0, 40)); return hits; })()`);
    assert.deepEqual(broken, []);
    assert.ok(await pop(`!!e.root.querySelector('.sd-popover legend')`), 'the type picker opened');
    assert.ok(await pop(`e.root.querySelectorAll('.sd-edge').length > 0`), 'links are drawn');
    await pop('(e.canvas.closePopover(), 1)');
    // The view tells typing from the canvas with the pop-out's own events.
    const typing = await pop(`(() => { const seen = {}; for (const [name, target] of [['source', e.code.textarea], ['canvas', e.canvas.stage]]) { target.addEventListener('keydown', (event) => { seen[name] = v.isTyping(event); }, { once: true }); target.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Shift', bubbles: true })); } return seen; })()`);
    assert.deepEqual(typing, { source: true, canvas: false });
    // No tooltip, and no error from Obsidian's tooltip code, over the canvas and the notes there.
    assert.deepEqual(await hover(`__popLeaf.view.editor.root.querySelector('[data-node="popped"]')`), []);
    assert.deepEqual(await hover(`__popLeaf.view.editor.root.querySelector('.sd-zoombar .sd-btn')`), ['Zoom out (-)']);
    await pop('(e.toggleNotes(true), 1)');
    await page.waitFor(`!!__popLeaf.view.editor.root.querySelector('.sd-notes-body a.internal-link')`, { what: 'the link in the notes' });
    assert.deepEqual(await hover(`__popLeaf.view.editor.root.querySelector('.sd-notes-body p')`), []);
    // A link in the notes opens its note from the pop-out too.
    await pop(`(e.root.querySelector('.sd-notes-body a.internal-link').click(), 1)`);
    await page.waitFor(`app.workspace.getLeavesOfType('markdown').some((l) => l.view.file?.path === 'Plain.md' && !!l.view.editor)`, { what: 'Plain.md opened from the link' });
    // Obsidian's own Markdown view errors if it is closed before it has settled.
    await sleep(1500);
    await page.eval(`(__popLeaf.detach(), delete window.__popLeaf, 1)`);
    await sleep(500);
  });

  test('PNG export lands in the vault; the view state survives reopening', async () => {
    await app.openNote('D.md');
    await page.waitFor(`app.workspace.getMostRecentLeaf()?.view?.editor?.text?.includes('service a')`);
    assert.ok(await app.command('archslate:export-png'));
    await page.waitFor(`!!app.vault.getAbstractFileByPath('D.png')`);
    await page.eval(`(() => { const e = app.workspace.getMostRecentLeaf().view.editor; e.toggleSource(true); e.canvas.zoomTo(1.7); })()`);
    await page.eval(`app.workspace.getMostRecentLeaf().detach()`);
    await sleep(400);
    await app.openNote('D.md');
    await page.waitFor(`app.workspace.getMostRecentLeaf()?.view?.editor?.sourceHidden === true`);
    assert.equal(await page.eval(`app.workspace.getMostRecentLeaf().view.editor.canvas.view.k`), 1.7);
  });

  test('mobile emulation: the diagram opens, with Undo, Redo and Fit in the header', async () => {
    await page.eval(`(localStorage.setItem('EmulateMobile', '1'), location.reload())`);
    await page.waitFor('window.app?.workspace?.layoutReady === true && !!app.plugins.plugins.archslate', { timeout: 30_000 });
    await app.openNote('Orders platform.md');
    await page.waitFor(`app.workspace.getMostRecentLeaf()?.view?.getViewType() === 'archslate'`, { timeout: 15_000 });
    const actions = await page.eval(`[...document.querySelectorAll('.workspace-leaf.mod-active .view-action')].map((a) => a.getAttribute('aria-label')).join(',')`);
    for (const label of ['Undo', 'Redo', 'Fit diagram', 'Open as Markdown']) assert.ok(actions.includes(label), `${label} in ${actions}`);
    await page.eval(`(localStorage.removeItem('EmulateMobile'), 1)`);
  });
});
