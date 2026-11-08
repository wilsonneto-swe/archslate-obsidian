// The built main.js loads against a stand-in for the `obsidian` module and
// registers what the plugin promises (needs npm run build:obsidian first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../dist/main.js', import.meta.url));

test('the bundle loads and registers its commands, view and code block', { skip: !existsSync(MAIN) && 'not built' }, () => {
  class Base {}
  const fake = {
    Plugin: class extends Base {},
    TextFileView: class extends Base {},
    MarkdownRenderChild: class extends Base {},
    Component: class extends Base {},
    MarkdownView: class extends Base {},
    WorkspaceLeaf: class { setViewState() {} },
    TFile: class {},
    TFolder: class {},
    Notice: class {},
    Scope: class { register() {} },
    Platform: { isMobile: false },
    Keymap: { isModEvent: () => false },
    MarkdownRenderer: { render: async () => {} },
    normalizePath: (p) => p,
    setIcon: () => {},
  };
  const module = { exports: {} };
  const source = readFileSync(MAIN, 'utf8');
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', source)(module, module.exports, (name) => {
    if (name === 'obsidian') return fake;
    throw new Error(`unexpected require("${name}")`);
  });
  const Plugin = module.exports.default ?? module.exports;
  assert.equal(typeof Plugin, 'function');

  const commands = [];
  const events = [];
  const plugin = new Plugin();
  Object.assign(plugin, {
    app: { workspace: { on: (name) => name, layoutReady: true }, vault: { on: (name) => name } },
    loadData: async () => null,
    registerView: (type) => (plugin.view = type),
    registerMarkdownCodeBlockProcessor: (language) => (plugin.language = language),
    addRibbonIcon: () => {},
    addCommand: (command) => commands.push(command.id),
    registerEvent: (name) => events.push(name),
  });
  return plugin.onload().then(() => {
    assert.equal(plugin.view, 'archslate');
    assert.equal(plugin.language, 'archslate');
    for (const id of ['new-diagram', 'open-as-diagram', 'open-as-markdown', 'always-open-as-diagram', 'stop-always-open-as-diagram', 'insert-diagram', 'save-version', 'export-png']) {
      assert.ok(commands.includes(id), id);
    }
    assert.ok(commands.every((id) => !id.includes('archslate')), 'command ids never repeat the plugin id');
    assert.deepEqual(events.sort(), ['delete', 'editor-menu', 'file-menu', 'quit', 'rename']);
    plugin.onunload?.call({ ...plugin, forEachDiagram() {}, flushData: async () => {} });
  });
});
