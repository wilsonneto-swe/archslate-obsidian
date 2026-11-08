// The REAL Obsidian app installed on this Mac, for the plugin's end-to-end
// tests and the README recordings, driven over the Chrome DevTools Protocol.
//
// ISOLATION (non-negotiable): every launch gets its own throwaway folder under
// ARCHSLATE_OBSIDIAN_TMP (default: the OS temp folder) holding the profile,
// passed as --user-data-dir, and the test vault, the only vault that profile
// knows. Obsidian's own profile (~/Library/Application Support/obsidian) and
// the user's vaults are never opened, read or written. Updates are off. The
// folder is removed when the app closes, and only the process started here is
// ended. Obsidian also serves a command-line socket in the home folder: the
// run refuses to start while the user's own Obsidian is open, and removes the
// socket afterwards if it was not there before.
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPage, sleep } from './cdp.mjs';

export const OBSIDIAN_APP = process.env.ARCHSLATE_OBSIDIAN_APP ?? '/Applications/Obsidian.app';
const BINARY = join(OBSIDIAN_APP, 'Contents', 'MacOS', 'Obsidian');
const TMP_BASE = resolve(process.env.ARCHSLATE_OBSIDIAN_TMP ?? tmpdir());
const REAL_PROFILE = join(homedir(), 'Library', 'Application Support', 'obsidian');
const CLI_SOCKET = join(homedir(), '.obsidian-cli.sock');
export const PLUGIN_DIST = process.env.ARCHSLATE_PLUGIN ?? fileURLToPath(new URL('../../apps/obsidian/dist', import.meta.url));

export function pluginId() {
  return JSON.parse(readFileSync(join(PLUGIN_DIST, 'manifest.json'), 'utf8')).id;
}

/** Obsidian main processes on the user's own profile (no --user-data-dir, or the real one). */
function userObsidian() {
  const r = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || !m[2].startsWith(BINARY)) continue;
    const dir = /--user-data-dir=(\S+)/.exec(m[2])?.[1];
    if (!dir || resolve(dir) === REAL_PROFILE) out.push(Number(m[1]));
  }
  return out;
}

/** Why Obsidian cannot be driven here, or null. */
export function unavailable() {
  if (process.platform !== 'darwin') return 'the Obsidian tests run on macOS';
  if (!existsSync(BINARY)) return `Obsidian is not installed (${OBSIDIAN_APP})`;
  if (!existsSync(join(PLUGIN_DIST, 'main.js'))) return 'the plugin is not built: npm run build:obsidian';
  const running = userObsidian();
  if (running.length) return `your own Obsidian is running (pid ${running.join(', ')}): quit it first`;
  return null;
}

function assertIsolated(profile) {
  const p = resolve(profile);
  if (!p.startsWith(TMP_BASE + sep) || p === REAL_PROFILE || p.startsWith(REAL_PROFILE + sep)) throw new Error(`refusing to start Obsidian on the profile ${p}`);
}

function vaultId(root) {
  let h = 0x811c9dc5;
  for (const c of root) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return `${h.toString(16)}a1b2c3d4e5f60718`.slice(0, 16);
}

async function stop(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  const t0 = Date.now();
  while (proc.exitCode === null && proc.signalCode === null && Date.now() - t0 < 10_000) await sleep(100);
  if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
}

export class ObsidianApp {
  /**
   * files: vault path -> text, written before the start.
   * theme: 'moonstone' (light, default) or 'obsidian' (dark).
   * size: the window's content size in CSS px.
   */
  static async launch({ files = {}, theme = 'moonstone', size = null, keep = false } = {}) {
    const why = unavailable();
    if (why) throw new Error(why);
    mkdirSync(TMP_BASE, { recursive: true });
    const root = mkdtempSync(join(TMP_BASE, 'archslate-obsidian-'));
    const vault = join(root, 'Archslate demo');
    const profile = join(root, 'profile');
    mkdirSync(join(vault, '.obsidian'), { recursive: true });
    mkdirSync(profile, { recursive: true });
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(vault, path)), { recursive: true });
      writeFileSync(join(vault, path), text);
    }
    writeFileSync(join(vault, '.obsidian', 'appearance.json'), JSON.stringify({ theme }));
    writeFileSync(join(vault, '.obsidian', 'app.json'), JSON.stringify({ nativeMenus: false, promptDelete: false }));
    writeFileSync(join(profile, 'obsidian.json'), JSON.stringify({ vaults: { [vaultId(root)]: { path: vault, ts: Date.now(), open: true } }, updateDisabled: true }));
    assertIsolated(profile);

    const socketBefore = existsSync(CLI_SOCKET);
    const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
    const proc = spawn(BINARY, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const logs = [];
    proc.stdout.on('data', (d) => logs.push(String(d)));
    proc.stderr.on('data', (d) => logs.push(String(d)));
    const app = new ObsidianApp(root, vault, profile, proc, logs, socketBefore, keep);
    try {
      const portFile = join(profile, 'DevToolsActivePort');
      const t0 = Date.now();
      while (!existsSync(portFile) || readFileSync(portFile, 'utf8').trim() === '') {
        if (proc.exitCode !== null) throw new Error(`Obsidian exited with ${proc.exitCode}:\n${logs.join('')}`);
        if (Date.now() - t0 > 30_000) throw new Error('Obsidian did not open its DevTools port in 30 s');
        await sleep(100);
      }
      const port = readFileSync(portFile, 'utf8').split('\n')[0];
      let target = null;
      while (!target) {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json().catch(() => []);
        target = list.find((t) => t.type === 'page' && t.url.startsWith('app://obsidian.md/index.html'));
        if (!target) {
          if (Date.now() - t0 > 40_000) throw new Error('Obsidian opened no vault window');
          await sleep(200);
        }
      }
      app.page = await connectPage(target.webSocketDebuggerUrl);
      await app.page.waitFor('window.app?.workspace?.layoutReady === true', { timeout: 30_000, what: 'the workspace' });
      if (size) await app.page.send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 0, mobile: false });
      await app.installPlugin();
      return app;
    } catch (error) {
      await app.close();
      throw error;
    }
  }

  constructor(root, vault, profile, proc, logs, socketBefore, keep) {
    Object.assign(this, { root, vault, profile, proc, logs, socketBefore, keep, page: null });
  }

  async installPlugin() {
    const id = pluginId();
    const dest = join(this.vault, '.obsidian', 'plugins', id);
    mkdirSync(dest, { recursive: true });
    for (const f of ['main.js', 'manifest.json', 'styles.css']) cpSync(join(PLUGIN_DIST, f), join(dest, f));
    await this.page.eval(`(async () => { await app.plugins.loadManifests(); await app.plugins.setEnable(true); await app.plugins.enablePluginAndSave(${JSON.stringify(id)}); })()`);
    await this.page.waitFor(`!!app.plugins.plugins[${JSON.stringify(id)}]`, { what: 'the plugin to load' });
  }

  path(note) {
    return join(this.vault, note);
  }

  read(note) {
    return readFileSync(this.path(note), 'utf8');
  }

  /** Writes a note from outside Obsidian (a sync tool, git). */
  write(note, text) {
    mkdirSync(dirname(this.path(note)), { recursive: true });
    writeFileSync(this.path(note), text);
  }

  async openNote(note, newTab = false) {
    await this.page.waitFor(`!!app.vault.getAbstractFileByPath(${JSON.stringify(note)})`, { what: note });
    await this.page.eval(`app.workspace.getLeaf(${JSON.stringify(newTab)}).openFile(app.vault.getAbstractFileByPath(${JSON.stringify(note)}))`);
    await sleep(400);
  }

  activeType() {
    return this.page.eval('app.workspace.getMostRecentLeaf()?.view?.getViewType() ?? null');
  }

  command(id) {
    return this.page.eval(`app.commands.executeCommandById(${JSON.stringify(id)})`);
  }

  async close() {
    this.page?.close();
    await stop(this.proc);
    if (!this.socketBefore && existsSync(CLI_SOCKET) && userObsidian().length === 0) {
      try {
        if (lstatSync(CLI_SOCKET).isSocket()) unlinkSync(CLI_SOCKET);
      } catch {
        // already gone
      }
    }
    if (!this.keep) rmSync(this.root, { recursive: true, force: true });
  }
}
