// npm run readme:media -- [scene...]: records the README's animations and the
// community directory's screenshots, in the real Obsidian app (an isolated
// profile and vault: e2e/helpers/obsidian.mjs) and in a headless Chrome for
// the web version. Needs `npm run build` first, Obsidian installed, and your
// own Obsidian closed.
//
// Scenes (all when none is named):
//   hero      .github/assets/archslate-obsidian.gif   text and canvas edit each other
//   versions  .github/assets/versions.gif             save a version, change, see the changes
//   flows     .github/assets/flows.gif                walk through a flow, step by step
//   shots     .github/assets/desktop-*.png            1200 x 800 listing screenshots
//   web       docs/images/web.png                     the web version
// The README's images go to .github/assets/ (the listing takes the screenshots from there too).
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from '../e2e/helpers/cdp.mjs';
import { ObsidianApp, unavailable } from '../e2e/helpers/obsidian.mjs';
import { serializeNewNote } from '../packages/core/document.js';
import { decodePng } from './lib/png.mjs';
import { encodeGif } from './lib/gif.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ASSETS = join(ROOT, '.github', 'assets');
const IMAGES = join(ROOT, 'docs', 'images');
const example = (name) => readFileSync(join(ROOT, 'examples', `${name}.md`), 'utf8');

const GIF_SIZE = { width: 960, height: 600 };
const SHOT_SIZE = { width: 1200, height: 800 };

const START = `# URL shortener
direction right

client web "Browser"
service api "Shortener API" x3
db links "Links" [Cassandra]

web -> api: GET /abc123
api -> links: read
`;

class Recorder {
  constructor(page) {
    this.page = page;
    this.frames = [];
  }

  async frame(ms = 100) {
    this.frames.push({ ...decodePng(await this.page.capture()), ms });
  }

  // A few frames while the canvas animates, then a hold.
  async settle(hold = 600) {
    for (let i = 0; i < 3; i += 1) {
      await sleep(70);
      await this.frame(90);
    }
    await sleep(120);
    await this.frame(hold);
  }

  async type(text, every = 2) {
    let n = 0;
    for (const ch of text) {
      if (ch === '\n') await this.page.key('Enter');
      else await this.page.send('Input.insertText', { text: ch });
      n += 1;
      if (n % every === 0) {
        await sleep(40);
        await this.frame(70);
      }
    }
  }

  save(path) {
    mkdirSync(join(path, '..'), { recursive: true });
    const gif = encodeGif(this.frames);
    writeFileSync(path, gif);
    console.log(`${path.replace(ROOT, '')}: ${this.frames.length} frames, ${Math.round(gif.length / 1024)} KB`);
  }
}

const view = (expr) => `(() => { const leaf = app.workspace.getLeavesOfType('archslate').find((l) => l === app.workspace.getMostRecentLeaf()) ?? app.workspace.getLeavesOfType('archslate')[0]; const v = leaf.view; const e = v.editor; return ${expr}; })()`;

async function tidy(app) {
  await app.page.eval(`(() => { app.workspace.leftSplit.collapse(); app.workspace.rightSplit.collapse(); document.body.classList.remove('show-inline-title'); })()`);
  await sleep(300);
}

async function openDiagram(app, note, state = {}) {
  await app.openNote(note);
  await app.page.waitFor(view('!!e'), { what: 'the diagram view' });
  await app.page.eval(view(`(e.setViewState(${JSON.stringify(state)}), e.select(null), 1)`));
  await sleep(600);
}

// The line where `text` starts, as the source pane counts.
const lineOf = (source, text) => source.split('\n').findIndex((line) => line.startsWith(text));

async function caretAtEndOf(app, lineText) {
  const source = await app.page.eval(view('e.text'));
  const line = lineOf(source, lineText);
  if (line < 0) throw new Error(`no line ${lineText}`);
  await app.page.eval(view(`(e.code.jumpTo(${line}, ${source.split('\n')[line].length}), 1)`));
}

async function hero() {
  const app = await ObsidianApp.launch({ size: GIF_SIZE, files: { 'URL shortener.md': serializeNewNote({ text: START, snapshots: [] }) } });
  try {
    const { page } = app;
    await page.send('Emulation.setDeviceMetricsOverride', { ...GIF_SIZE, deviceScaleFactor: 1, mobile: false });
    await tidy(app);
    await openDiagram(app, 'URL shortener.md', { codeWidth: '38%' });
    const rec = new Recorder(page);
    await rec.frame(1400);

    // 1. Typing in the source: the canvas follows.
    await caretAtEndOf(app, 'db links');
    await rec.frame(300);
    await rec.type('\ncache hot "Hot links" [Redis]');
    await rec.settle(700);
    await caretAtEndOf(app, 'api -> links');
    await rec.type('\napi -> hot: lookup first');
    await rec.settle(1300);

    // 2. Clicking on the canvas: the source follows.
    const { x, y } = await page.center('.workspace-leaf.mod-active [data-node="api"] .sd-node-box');
    await page.click(x, y);
    await rec.settle(700);
    await page.key('Tab');
    await sleep(250);
    await rec.frame(500);
    await rec.type('Click events', 3);
    await page.clickOn('.sd-add-popover input[value="queue"] + .sd-kind-face');
    await rec.settle(700);
    await page.key('Enter');
    await rec.settle(1400);
    await page.key('Escape');
    await rec.settle(2600);
    rec.save(join(ASSETS, 'archslate-obsidian.gif'));
  } finally {
    await app.close();
  }
}

const WITH_CACHE = START.replace('db links "Links" [Cassandra]\n', 'db links "Links" [Cassandra]\ncache hot "Hot links" [Redis]\n').replace('api -> links: read\n', 'api -> links: read\napi -> hot: lookup first\n');

async function versions() {
  const app = await ObsidianApp.launch({ size: GIF_SIZE, files: { 'URL shortener.md': serializeNewNote({ text: WITH_CACHE, snapshots: [] }) } });
  try {
    const { page } = app;
    await page.send('Emulation.setDeviceMetricsOverride', { ...GIF_SIZE, deviceScaleFactor: 1, mobile: false });
    await tidy(app);
    await openDiagram(app, 'URL shortener.md', { codeWidth: '38%' });
    const rec = new Recorder(page);
    await rec.frame(1000);

    // Save a version.
    await page.clickOn('.workspace-leaf.mod-active .sd-tl-save');
    await sleep(200);
    await rec.frame(300);
    await rec.type('with cache', 2);
    await page.key('Enter');
    await rec.settle(1000);

    // Change things: scale out, add a rate limiter.
    await caretAtEndOf(app, 'service api');
    await page.key('Backspace');
    await rec.frame(150);
    await rec.type('6', 1);
    await rec.settle(500);
    await caretAtEndOf(app, 'cache hot');
    await rec.type('\nratelimiter limiter "Rate limiter"');
    await rec.settle(500);
    await caretAtEndOf(app, 'web -> api');
    await rec.type('\nweb -> limiter: check first');
    await rec.settle(900);

    // What changed since the version.
    await page.eval(view('(e.canvas.focus(), 1)'));
    await page.key('c');
    await rec.settle(3200);
    await page.clickOn('.workspace-leaf.mod-active .sd-tl-item:not(.sd-tl-now) .sd-tl-main');
    await rec.settle(2000);
    await page.clickOn('.workspace-leaf.mod-active .sd-tl-now .sd-tl-main');
    await rec.settle(1600);
    rec.save(join(ASSETS, 'versions.gif'));
  } finally {
    await app.close();
  }
}

async function flows() {
  const app = await ObsidianApp.launch({ size: GIF_SIZE, files: { 'Chat app.md': example('Chat app') } });
  try {
    const { page } = app;
    await page.send('Emulation.setDeviceMetricsOverride', { ...GIF_SIZE, deviceScaleFactor: 1, mobile: false });
    await tidy(app);
    await openDiagram(app, 'Chat app.md', { sourceHidden: true, notes: false });
    const rec = new Recorder(page);
    await rec.frame(1200);
    await page.clickOn('.workspace-leaf.mod-active .sd-flow-chip');
    await rec.settle(3000);
    await page.eval(view('(e.canvas.focus(), 1)'));
    await page.key('w');
    await rec.settle(2600);
    await page.key('Escape');
    await rec.settle(1200);
    rec.save(join(ASSETS, 'flows.gif'));
  } finally {
    await app.close();
  }
}

async function shots() {
  mkdirSync(ASSETS, { recursive: true });
  const files = {
    'URL shortener.md': example('URL shortener'),
    'Orders platform.md': example('Orders platform'),
    'Rate limiter.md': example('Rate limiter'),
  };
  for (const theme of ['moonstone', 'obsidian']) {
    const app = await ObsidianApp.launch({ size: SHOT_SIZE, theme, files });
    try {
      const { page } = app;
      await page.send('Emulation.setDeviceMetricsOverride', { ...SHOT_SIZE, deviceScaleFactor: 1, mobile: false });
      await tidy(app);
      if (theme === 'moonstone') {
        await openDiagram(app, 'URL shortener.md', { codeWidth: '30%', notes: true });
        await page.eval(view(`(e.setFlow('redirect'), 1)`));
        await sleep(800);
        await page.shot(join(ASSETS, 'desktop-1-diagram-light.png'));
        // The same kind of note, read as a note: the block is drawn, the notes are Markdown.
        await app.openNote('Rate limiter.md');
        await sleep(400);
        await app.command('archslate:open-as-markdown');
        await sleep(400);
        await page.eval(`(async () => { const leaf = app.workspace.getMostRecentLeaf(); await leaf.setViewState({ ...leaf.getViewState(), state: { ...leaf.getViewState().state, mode: 'preview' } }); })()`);
        await sleep(1200);
        await page.shot(join(ASSETS, 'desktop-3-note-light.png'));
      } else {
        await openDiagram(app, 'Orders platform.md', { codeWidth: '30%', notes: false });
        await page.eval(view(`(e.toggleChanges(), 1)`));
        await sleep(900);
        await page.shot(join(ASSETS, 'desktop-2-changes-dark.png'));
      }
    } finally {
      await app.close();
    }
  }
  console.log('wrote the listing screenshots');
}

// The web version, as published (apps/web/dist), served here on a free port.
async function web() {
  const dist = join(ROOT, 'apps', 'web', 'dist');
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    try {
      const file = join(dist, path || 'index.html');
      if (!file.startsWith(dist)) throw new Error('outside');
      res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { page, close } = await launchChrome(SHOT_SIZE);
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.eval(`(localStorage.setItem('archslate:web:theme', 'light'), location.reload())`);
    await sleep(1200);
    await page.eval(`(diagramEditor.setFlow('place_order'), 1)`);
    await sleep(800);
    mkdirSync(IMAGES, { recursive: true });
    await page.shot(join(IMAGES, 'web.png'));
    console.log('wrote docs/images/web.png');
  } finally {
    await close();
    server.close();
  }
}

const SCENES = { hero, versions, flows, shots, web };

const wanted = process.argv.slice(2);
const why = unavailable();
if (why) {
  console.error(`readme:media: ${why}`);
  process.exit(1);
}
for (const name of wanted.length ? wanted : Object.keys(SCENES)) {
  if (!SCENES[name]) throw new Error(`no scene ${name}`);
  await SCENES[name]();
}
