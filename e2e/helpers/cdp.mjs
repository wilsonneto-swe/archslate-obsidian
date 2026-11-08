// A small Chrome DevTools Protocol driver over Node's built-in WebSocket: no
// dependencies. It drives either a Chrome it starts itself (launchChrome, for
// the web version) or a page it is pointed at (connectPage, for Obsidian).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
};

/** A driver for one page target, given its WebSocket debugger URL. */
export async function connectPage(webSocketUrl, { width, height, scale = 1 } = {}) {
  const ws = new WebSocket(webSocketUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    } else if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(`[console.${msg.params.type}] ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push(`[exception] ${d.exception?.description ?? d.text}`);
    } else if (msg.method === 'Log.entryAdded') {
      logs.push(`[log.${msg.params.entry.level}] ${msg.params.entry.text} ${msg.params.entry.url ?? ''}`);
    }
  });
  const send = (method, params = {}) => {
    id += 1;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  if (width && height) await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });

  const page = {
    logs,
    send,
    sleep,
    async goto(url) {
      await send('Page.navigate', { url });
      await sleep(900);
    },
    async eval(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    async waitFor(expression, { timeout = 10_000, what = expression } = {}) {
      const t0 = Date.now();
      for (;;) {
        if (await page.eval(expression).catch(() => false)) return;
        if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
      }
    },
    /** A PNG of the page (or of `clip`), as a Buffer. */
    async capture(clip) {
      const params = { format: 'png' };
      if (clip) params.clip = { ...clip, scale: clip.scale ?? 1 };
      const { data } = await send('Page.captureScreenshot', params);
      return Buffer.from(data, 'base64');
    },
    async shot(path, clip) {
      writeFileSync(path, await page.capture(clip));
      return path;
    },
    async center(selector) {
      const json = await page.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`);
      if (!json) throw new Error(`no element ${selector}`);
      return JSON.parse(json);
    },
    async mouse(type, x, y, extra = {}) {
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
    },
    async move(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    },
    async click(x, y, extra = {}) {
      await page.mouse('mousePressed', x, y, extra);
      await page.mouse('mouseReleased', x, y, extra);
      await sleep(80);
    },
    async clickOn(selector) {
      const { x, y } = await page.center(selector);
      await page.click(x, y);
    },
    async dblclick(x, y) {
      await page.mouse('mousePressed', x, y, { clickCount: 1 });
      await page.mouse('mouseReleased', x, y, { clickCount: 1 });
      await page.mouse('mousePressed', x, y, { clickCount: 2 });
      await page.mouse('mouseReleased', x, y, { clickCount: 2 });
      await sleep(120);
    },
    async drag(from, to, steps = 10, delay = 16) {
      await page.mouse('mousePressed', from.x, from.y);
      for (let i = 1; i <= steps; i += 1) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, button: 'left', buttons: 1 });
        await sleep(delay);
      }
      await page.mouse('mouseReleased', to.x, to.y);
      await sleep(120);
    },
    /** modifiers: 1 alt, 2 ctrl, 4 meta, 8 shift */
    async key(key, modifiers = 0) {
      const info = KEYS[key] ?? { code: key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key, keyCode: key.toUpperCase().charCodeAt(0), text: key };
      const text = modifiers & ~8 ? undefined : info.text;
      await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code: info.code, windowsVirtualKeyCode: info.keyCode, text, modifiers });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: info.code, windowsVirtualKeyCode: info.keyCode, modifiers });
      await sleep(60);
    },
    async type(text) {
      await send('Input.insertText', { text });
      await sleep(60);
    },
    /** Types like a person, one character at a time. */
    async typeSlowly(text, delay = 45) {
      for (const ch of text) {
        if (ch === '\n') await page.key('Enter');
        else await send('Input.insertText', { text: ch });
        await sleep(delay);
      }
    },
    close() {
      ws.close();
    },
  };
  return page;
}

// Why Chrome can't run here, or null: the web tests skip with that reason.
export function chromeUnavailable() {
  return existsSync(CHROME) ? null : `Chrome not found at ${CHROME} (set CHROME to its path)`;
}

/** Starts a headless Chrome with a throwaway profile; returns { page, newPage, close }. */
export async function launchChrome({ width = 1440, height = 900, scale = 1 } = {}) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME)`);
  const profile = mkdtempSync(join(tmpdir(), 'archslate-chrome-'));
  const port = 9500 + Math.floor(Math.random() * 400);
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 100 && !target; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === 'page');
    } catch {
      // not up yet
    }
    if (!target) await sleep(100);
  }
  if (!target) throw new Error('Chrome did not start');
  const page = await connectPage(target.webSocketDebuggerUrl, { width, height, scale });
  return {
    page,
    // Another tab in the same browser (same profile, so the same localStorage).
    // Its close() closes the tab, and the first page comes back to the front:
    // a tab in the background never finishes handling the keys it is sent.
    async newPage(url = 'about:blank') {
      const created = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
      const other = await connectPage(created.webSocketDebuggerUrl, { width, height, scale });
      const disconnect = other.close;
      other.close = async () => {
        disconnect();
        await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
        await page.send('Page.bringToFront');
      };
      return other;
    },
    async close() {
      page.close();
      proc.kill();
      await sleep(200);
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}
