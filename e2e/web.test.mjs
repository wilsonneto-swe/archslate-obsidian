// The web version (apps/web/dist, served here) in a headless Chrome: opening,
// saving and dropping files, the Content-Security-Policy, editing from the
// canvas and the source. Needs `npm run build:web` and Google Chrome.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromeUnavailable, launchChrome, sleep } from './helpers/cdp.mjs';

const DIST = fileURLToPath(new URL('../apps/web/dist', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const NOTE = readFileSync(new URL('../examples/Rate limiter.md', import.meta.url), 'utf8');

const skip = (!existsSync(join(DIST, 'index.html')) && 'not built: npm run build:web') || chromeUnavailable() || false;

describe('Archslate on the web', { skip }, () => {
  let server;
  let chrome;
  let page;
  let url;

  before(async () => {
    server = createServer((req, res) => {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[/\\]+/, '');
      const file = join(DIST, path || 'index.html');
      if (!file.startsWith(DIST) || !existsSync(file)) return res.writeHead(404).end();
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}/`;
    chrome = await launchChrome({ width: 1300, height: 820 });
    page = chrome.page;
    await page.goto(url);
    await page.waitFor('!!window.diagramEditor');
    await page.eval(`window.confirm = () => true; window.__saved = []; diagramEditor.host.saveFile = (name, blob) => blob.text().then((t) => window.__saved.push({ name, type: blob.type, text: t }))`);
  });
  after(async () => {
    const problems = page?.logs.filter((l) => /Refused|Content Security Policy|\[exception\]/.test(l)) ?? [];
    await chrome?.close();
    server?.close();
    assert.deepEqual(problems, [], 'no CSP violations or exceptions');
  });

  test('the example loads with its versions', async () => {
    assert.equal(await page.eval('diagramEditor.document.snapshots.length'), 2);
    assert.ok((await page.eval('document.querySelectorAll(".sd-node").length')) >= 10);
  });

  test('Save downloads the diagram as a note with its versions', async () => {
    await page.clickOn('#save-file');
    await page.waitFor('window.__saved.length === 1');
    const saved = (await page.eval('JSON.stringify(window.__saved[0])')).length && JSON.parse(await page.eval('JSON.stringify(window.__saved[0])'));
    assert.equal(saved.name, 'orders-platform.md');
    assert.ok(saved.text.startsWith('---\narchslate: diagram\n---\n\n```archslate\n'));
    assert.ok(saved.text.includes('%% archslate:versions'));
  });

  test('dropping a note opens it; saving it again keeps it byte for byte', async () => {
    await page.eval(`(() => { const dt = new DataTransfer(); dt.items.add(new File([${JSON.stringify(NOTE)}], 'Rate limiter.md', { type: 'text/markdown' })); for (const t of ['dragenter', 'dragover', 'drop']) window.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
    await page.waitFor(`diagramEditor.text.includes('ratelimiter limiter')`);
    await page.eval('window.__saved = []');
    await page.clickOn('#save-file');
    await page.waitFor('window.__saved.length === 1');
    assert.equal(await page.eval('window.__saved[0].text'), NOTE);
  });

  test('a file that is not a diagram is refused with a message', async () => {
    await page.eval(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['{oops'], 'bad.json')); window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); })()`);
    await page.waitFor(`!!document.querySelector('.sd-toast.is-error')`);
    assert.ok(await page.eval(`diagramEditor.text.includes('ratelimiter limiter')`));
  });

  test('the canvas and the source edit the same text', async () => {
    await page.eval(`(diagramEditor.select({ type: 'node', id: 'backend' }), diagramEditor.canvas.focus(), 1)`);
    await page.key('Tab');
    await sleep(200);
    await page.type('Audit log');
    await page.key('Enter');
    await page.waitFor(`diagramEditor.text.includes('"Audit log"')`);
    assert.ok(await page.eval(`diagramEditor.text.includes('backend -> audit_log')`));
    await page.eval(`(() => { const ta = diagramEditor.code.textarea; ta.focus(); const at = ta.value.indexOf('\\n---'); ta.setSelectionRange(at, at); })()`);
    await page.type('\ncache c2 "Second cache"');
    await page.waitFor(`!!document.querySelector('[data-node="c2"]')`);
  });

  test('links in the notes are drawn, a bare URL included', async () => {
    await page.eval(`(diagramEditor.toggleNotes(true), diagramEditor.commit({ text: diagramEditor.text + '\\nSee https://example.com/a and <https://example.org/b>.\\n' }, { source: 'code' }), 1)`);
    await page.waitFor(`!!document.querySelector('.sd-notes-body a[href="https://example.com/a"]')`);
    assert.ok(await page.eval(`!!document.querySelector('.sd-notes-body a[href="https://example.org/b"]')`));
    assert.ok(await page.eval(`document.querySelectorAll('.sd-node').length > 0`));
  });

  test('two tabs share the diagram, and a tab left open never writes over the other', async () => {
    const other = await chrome.newPage(url);
    try {
      await other.waitFor('!!window.diagramEditor');
      await page.eval(`(diagramEditor.commit({ text: 'cache shared "From tab A"\\n' + diagramEditor.text }, { source: 'code' }), diagramEditor.saveNow(), 1)`);
      await other.waitFor(`diagramEditor.text.includes('From tab A')`, { what: 'the other tab to follow' });
      await other.goto('about:blank');
      await sleep(300);
      assert.ok((await page.eval(`localStorage.getItem('archslate:web:document')`)).includes('From tab A'));
    } finally {
      await other.close();
    }
  });

  test('in a form, Tab then Enter presses the focused button (not a canvas shortcut)', async () => {
    await page.eval(`(diagramEditor.select({ type: 'node', id: 'backend' }), diagramEditor.canvas.focus(), 1)`);
    await page.key('d');
    await page.waitFor(`!!document.querySelector('.sd-details-form')`);
    await page.eval(`(() => { const form = document.querySelector('.sd-details-form'); form.querySelector('input').value = '7'; form.querySelector('button[type=submit]').focus(); })()`);
    await page.key('Enter');
    await page.waitFor(`/service backend[^\\n]* x7/.test(diagramEditor.text)`, { what: 'the details to be saved' });
    assert.equal(await page.eval(`!!document.querySelector('.sd-rename')`), false, 'Enter did not start a rename');
  });

  test('a version form left open does not take the keys typed in the source', async () => {
    await page.eval(`(diagramEditor.canvas.focus(), diagramEditor.timeline.openSave(), 1)`);
    assert.ok(await page.eval(`document.activeElement?.closest('.sd-tl-form') !== null`));
    await page.eval(`(() => { const ta = diagramEditor.code.textarea; ta.focus(); ta.setSelectionRange(0, 0); })()`);
    await page.type('# a comment\n');
    await sleep(200);
    assert.ok(await page.eval(`diagramEditor.text.startsWith('# a comment\\n')`));
    assert.equal(await page.eval(`document.activeElement === diagramEditor.code.textarea`), true);
    assert.equal(await page.eval(`!!document.querySelector('.sd-tl-form')`), false, 'the form closed when focus left it');
  });

  test('two fingers pinch the canvas to zoom', async () => {
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    try {
      const box = JSON.parse(await page.eval(`JSON.stringify(diagramEditor.canvas.stage.getBoundingClientRect())`));
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      const before = await page.eval('diagramEditor.canvas.view.k');
      const points = (spread) => [{ x: cx - spread, y: cy, id: 1 }, { x: cx + spread, y: cy, id: 2 }];
      await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(40) });
      for (const spread of [60, 80, 100, 120]) {
        await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(spread) });
        await sleep(30);
      }
      await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const after = await page.eval('diagramEditor.canvas.view.k');
      assert.ok(after > before * 2, `zoomed in: ${before} -> ${after}`);
    } finally {
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    }
  });

  test('the strict Content-Security-Policy holds through a PNG export', async () => {
    await page.eval('window.__saved = []; diagramEditor.exportImage("png")');
    await page.waitFor('window.__saved.length === 1', { timeout: 8000 });
    assert.equal(await page.eval('window.__saved[0].type'), 'image/png');
  });
});
