// Archslate for Obsidian: a note holds a system design diagram as text, opens
// as an editor (canvas + source + versions), and stays an ordinary Markdown
// note. The editor itself lives in packages/; this plugin hosts it in a view
// (view.js) and connects it to Obsidian:
//  - OPEN: "Open as diagram" (this tab), "Open as diagram in a split", "Open as
//    Markdown" (commands, the file menu, the editor menu, the view's header).
//    Opening a note as a diagram never writes it.
//  - FLAG: "Always open as diagram" sets `archslate: diagram` in the note's
//    properties ("Stop always opening..." takes it out); AUTO-OPEN
//    (auto-open.js) then opens it as a diagram wherever Obsidian opens it,
//    through a patch of WorkspaceLeaf.setViewState (patch.js) that is undone on
//    unload. A tab where the user chose Markdown keeps it.
//  - NEW: "New diagram" (command, ribbon, a folder's menu) creates a flagged
//    note where Obsidian puts new notes, or in that folder, and opens it.
//  - DRAW: an ```archslate block in any note is drawn in reading view and live
//    preview. The block the editor edits (the first at the note's top level)
//    gets a button that opens the note as a diagram.
//  - VIEW-STATE (view-state.js): camera and panels per note, following renames.
//  - EXPORT: PNG and SVG go to the vault's attachment folder.

import { Keymap, MarkdownRenderChild, MarkdownView, Notice, Plugin, TFile, TFolder, WorkspaceLeaf, normalizePath, setIcon } from 'obsidian';
import { blockSource, serializeNewNote } from '../../../packages/core/document.js';
import { renderDiagram } from '../../../packages/ui/embed.js';
import { opensAsDiagram, renamedPath, untitledName } from './auto-open.js';
import { BLOCK_TEMPLATE, FLAG_KEY, FLAG_VALUE, ICON, LANGUAGE, NEW_DIAGRAM_NAME, STARTER, VIEW_TYPE } from './constants.js';
import { patchMethod } from './patch.js';
import { DiagramView } from './view.js';
import { ViewStateStore } from './view-state.js';

/** @typedef {import('obsidian').PaneType} PaneType */
/** @typedef {import('../../../packages/ui/editor.js').DiagramEditor} DiagramEditor */
/** @typedef {import('../../../packages/types').OpenChoice} OpenChoice */
/** @typedef {import('../../../packages/types').ViewState} ViewState */

/**
 * A state a tab (leaf) is asked to show: the view type and its own state (`state.file` for a note).
 * @typedef {import('obsidian').ViewState} LeafState
 */

/**
 * The plugin's data as loadData() reads it back from data.json: what was saved,
 * or an older shape, a hand edit (ViewStateStore checks every view state).
 * @typedef {import('../../../packages/types').StoredPluginData} StoredPluginData
 */

const DATA_SAVE_MS = 1500;

// Lines compared without their indentation or trailing spaces.
/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
const sameSource = (a, b) => {
  const norm = (/** @type {string} */ text) => text.replace(/\r/g, '').split('\n').map((line) => line.trim()).join('\n').trim();
  return norm(a) === norm(b);
};

// A drawn code block. The block the editor edits gets a button that opens the
// note in the editor; one inside a callout or a list, or a second block, is
// only drawn (opening the note would show the other block, or none).
class DiagramBlock extends MarkdownRenderChild {
  constructor(/** @type {HTMLElement} */ containerEl, /** @type {string} */ source, /** @type {ArchslatePlugin} */ plugin, /** @type {string} */ sourcePath) {
    super(containerEl);
    this.source = source;
    this.plugin = plugin;
    this.sourcePath = sourcePath;
  }

  onload() {
    const { root } = renderDiagram(this.containerEl, this.source);
    const file = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
    if (!(file instanceof TFile) || file.extension !== 'md') return;
    void this.plugin.app.vault.cachedRead(file).then((content) => {
      const editable = blockSource(content);
      if (editable === null || !sameSource(editable, this.source) || !root.isConnected) return;
      const open = root.createEl('button', { cls: 'archslate-open clickable-icon', attr: { 'aria-label': 'Open as diagram' } });
      setIcon(open, ICON);
      this.registerDomEvent(open, 'click', (event) => {
        event.preventDefault();
        void this.plugin.openAsDiagram(this.plugin.app.workspace.getLeaf(Keymap.isModEvent(event)), file);
      });
    });
  }
}

export default class ArchslatePlugin extends Plugin {
  async onload() {
    /** @type {StoredPluginData} */
    const data = (await this.loadData()) ?? {};
    this.viewStates = new ViewStateStore(data.viewState);
    /**
     * What the user chose to open each note as, per tab: only for as long as the tab lives.
     * @type {WeakMap<WorkspaceLeaf, Map<string, OpenChoice>>}
     */
    this.choices = new WeakMap();
    /**
     * The pending save of the plugin's data.
     * @type {number | null}
     */
    this.dataTimer = null;

    this.registerView(VIEW_TYPE, (leaf) => new DiagramView(leaf, this));
    this.patchLeaves();
    this.registerMarkdownCodeBlockProcessor(LANGUAGE, (source, el, ctx) => {
      ctx.addChild(new DiagramBlock(el, source, this, ctx.sourcePath));
    });

    this.addRibbonIcon(ICON, 'New diagram', (event) => void this.newDiagram(undefined, Keymap.isModEvent(event)));
    this.registerCommands();
    this.registerMenus();

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (this.viewStates.rename(oldPath, file.path)) this.scheduleData();
        this.app.workspace.iterateAllLeaves((leaf) => {
          const notes = this.choices.get(leaf);
          if (!notes) return;
          for (const [path, choice] of [...notes]) {
            const to = renamedPath(path, oldPath, file.path);
            if (to === null) continue;
            notes.delete(path);
            notes.set(to, choice);
          }
        });
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (this.viewStates.delete(file.path)) this.scheduleData();
      }),
    );
    // Quitting: every diagram is written before Obsidian closes.
    this.registerEvent(
      this.app.workspace.on('quit', (tasks) => {
        tasks.add(async () => {
          /** @type {Promise<void>[]} */
          const saves = [];
          this.forEachDiagram((view) => {
            view.rememberViewState();
            saves.push(view.saveNow());
          });
          await Promise.all(saves);
          await this.flushData();
        });
      }),
    );
  }

  onunload() {
    this.unpatch?.();
    this.unpatch = null;
    this.forEachDiagram((view) => view.rememberViewState());
    void this.flushData();
  }

  // ---------------------------------------------------------------- commands

  registerCommands() {
    /**
     * A command on the diagram in the active tab, offered only when there is one.
     * @param {string} id
     * @param {string} name
     * @param {string} icon
     * @param {(view: DiagramView & { editor: DiagramEditor }) => void} run
     */
    const diagramCommand = (id, name, icon, run) =>
      this.addCommand({
        id,
        name,
        icon,
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(DiagramView);
          if (!view?.editor) return false;
          if (!checking) run(view);
          return true;
        },
      });

    this.addCommand({ id: 'new-diagram', name: 'New diagram', icon: ICON, callback: () => void this.newDiagram() });
    this.addCommand({
      id: 'open-as-diagram',
      name: 'Open as diagram',
      icon: ICON,
      checkCallback: (checking) => {
        const target = this.markdownTarget();
        if (!target) return false;
        if (!checking) void this.openAsDiagram(target.leaf, target.file);
        return true;
      },
    });
    this.addCommand({
      id: 'open-as-diagram-in-split',
      name: 'Open as diagram in a split',
      icon: ICON,
      checkCallback: (checking) => {
        const target = this.markdownTarget();
        if (!target) return false;
        if (!checking) void this.openAsDiagram(this.app.workspace.getLeaf('split', 'vertical'), target.file);
        return true;
      },
    });
    this.addCommand({
      id: 'open-as-markdown',
      name: 'Open as Markdown',
      icon: 'file-text',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(DiagramView);
        if (!view?.file) return false;
        if (!checking) void this.openAsMarkdown(view.leaf);
        return true;
      },
    });
    // One command per direction, each offered only when it changes something.
    /**
     * @param {string} id
     * @param {string} name
     * @param {boolean} on
     */
    const flagCommand = (id, name, on) =>
      this.addCommand({
        id,
        name,
        icon: ICON,
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.extension !== 'md' || this.isFlagged(file) === on) return false;
          if (!checking) void this.setFlag(file, on);
          return true;
        },
      });
    flagCommand('always-open-as-diagram', 'Always open this note as a diagram', true);
    flagCommand('stop-always-open-as-diagram', 'Stop always opening this note as a diagram', false);
    this.addCommand({
      id: 'insert-diagram',
      name: 'Insert diagram',
      icon: ICON,
      editorCallback: (editor) => {
        const at = editor.getCursor();
        const before = at.ch === 0 ? '' : '\n';
        editor.replaceSelection(`${before}${BLOCK_TEMPLATE}`);
      },
    });
    diagramCommand('save-version', 'Save a version', 'bookmark-plus', (view) => view.editor.timeline.openSave());
    diagramCommand('toggle-changes', 'Show changes against the previous version', 'git-compare', (view) => view.editor.toggleChanges());
    diagramCommand('toggle-source', 'Show or hide the source', 'code', (view) => view.editor.toggleSource());
    diagramCommand('toggle-notes', 'Show or hide the notes', 'file-text', (view) => view.editor.toggleNotes());
    diagramCommand('next-flow', 'Walk through the next flow', 'route', (view) => view.editor.cycleFlow());
    diagramCommand('fit', 'Fit the diagram to the view', 'maximize', (view) => view.editor.canvas.fit(true));
    diagramCommand('export-png', 'Export as PNG', 'image', (view) => void view.editor.exportImage('png'));
    diagramCommand('export-svg', 'Export as SVG', 'image', (view) => void view.editor.exportImage('svg'));
  }

  registerMenus() {
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file, source, leaf) => {
        if (file instanceof TFolder) {
          if (source === 'file-explorer-context-menu') {
            menu.addItem((item) =>
              item
                .setSection('action-primary')
                .setTitle('New diagram')
                .setIcon(ICON)
                .onClick((event) => void this.newDiagram(file, Keymap.isModEvent(event))),
            );
          }
          return;
        }
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        const view = leaf?.view;
        if (view instanceof DiagramView && view.file === file) {
          menu.addItem((item) => item.setSection('open').setTitle('Open as Markdown').setIcon('file-text').onClick(() => void this.openAsMarkdown(view.leaf)));
        } else {
          const target = leaf && (source === 'more-options' || source === 'tab-header') ? leaf : null;
          menu.addItem((item) =>
            item
              .setSection('open')
              .setTitle('Open as diagram')
              .setIcon(ICON)
              .onClick(() => void this.openAsDiagram(target ?? this.app.workspace.getLeaf(false), file)),
          );
        }
        menu.addItem((item) =>
          item
            .setSection('action')
            .setTitle('Always open as diagram')
            .setIcon(ICON)
            .setChecked(this.isFlagged(file))
            .onClick(() => void this.setFlag(file, !this.isFlagged(file))),
        );
      }),
    );
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, _editor, info) => {
        const file = info.file;
        if (!(info instanceof MarkdownView) || !(file instanceof TFile) || file.extension !== 'md') return;
        menu.addItem((item) =>
          item
            .setSection('view')
            .setTitle('Open as diagram')
            .setIcon(ICON)
            .onClick(() => void this.openAsDiagram(info.leaf, file)),
        );
      }),
    );
  }

  // ----------------------------------------------------------------- opening

  markdownTarget() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    return view && file instanceof TFile && file.extension === 'md' ? { leaf: view.leaf, file } : null;
  }

  choose(/** @type {WorkspaceLeaf} */ leaf, /** @type {string} */ path, /** @type {OpenChoice} */ choice) {
    /** @type {Map<string, OpenChoice>} */
    const notes = this.choices.get(leaf) ?? new Map();
    notes.set(path, choice);
    this.choices.set(leaf, notes);
  }

  // The same note in another view: no history entry, the tab is focused.
  async switchView(/** @type {WorkspaceLeaf} */ leaf, /** @type {string} */ type, /** @type {TFile} */ file) {
    await leaf.setViewState({ type, state: { file: file.path }, active: true, popstate: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  async openAsDiagram(/** @type {WorkspaceLeaf} */ leaf, /** @type {TFile} */ file) {
    this.choose(leaf, file.path, 'diagram');
    await this.switchView(leaf, VIEW_TYPE, file);
  }

  async openAsMarkdown(/** @type {WorkspaceLeaf} */ leaf) {
    const view = leaf.view;
    if (!(view instanceof DiagramView) || !view.file) return;
    const file = view.file;
    await view.saveNow();
    this.choose(leaf, file.path, 'markdown');
    await this.switchView(leaf, 'markdown', file);
  }

  // AUTO-OPEN: setViewState hands a flagged note to the diagram view.
  patchLeaves() {
    /**
     * What `leaf` shows when asked for `state`: the same note in the diagram view when it opens as a diagram, `state` otherwise.
     * @param {WorkspaceLeaf} leaf
     * @param {LeafState} state
     * @returns {LeafState}
     */
    const stateFor = (leaf, state) => {
      const file = state?.state?.file;
      const path = typeof file === 'string' ? file : null;
      const choice = path !== null ? this.choices.get(leaf)?.get(path) : undefined;
      const flagged = path !== null && state.type === 'markdown' && this.isFlaggedPath(path);
      // A background tab restored at startup loads when first shown: a restore too.
      const restoring = leaf.isDeferred === true;
      return opensAsDiagram({ type: state?.type, path, layoutReady: this.app.workspace.layoutReady, restoring, choice, flagged }) ? { ...state, type: VIEW_TYPE } : state;
    };
    this.unpatch = patchMethod(WorkspaceLeaf.prototype, 'setViewState', (original) =>
      function setViewState(state, eState) {
        return original.call(this, stateFor(this, state), eState);
      },
    );
  }

  isFlagged(/** @type {TFile} */ file) {
    return this.app.metadataCache.getFileCache(file)?.frontmatter?.[FLAG_KEY] === FLAG_VALUE;
  }

  isFlaggedPath(/** @type {string} */ path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile && file.extension === 'md' && this.isFlagged(file);
  }

  // ---------------------------------------------------------------- the flag

  async setFlag(/** @type {TFile} */ file, /** @type {boolean} */ on) {
    /** @type {Promise<void>[]} */
    const saves = [];
    this.forEachDiagram((view) => {
      if (view.file === file) saves.push(view.saveNow());
    });
    await Promise.all(saves);
    await this.app.fileManager.processFrontMatter(file, (/** @type {Record<string, unknown>} */ frontmatter) => {
      if (on) frontmatter[FLAG_KEY] = FLAG_VALUE;
      else delete frontmatter[FLAG_KEY];
    });
    new Notice(on ? `“${file.basename}” opens as a diagram from now on.` : `“${file.basename}” opens as Markdown again.`);
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (on && view?.file === file) await this.openAsDiagram(view.leaf, file);
  }

  // --------------------------------------------------------------- new ones

  async newDiagram(/** @type {TFolder | undefined} */ folder, /** @type {PaneType | boolean} */ where = false) {
    const parent = folder ?? this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? '');
    const dir = parent.isRoot() ? '' : `${parent.path}/`;
    const name = untitledName((candidate) => this.app.vault.getAbstractFileByPath(normalizePath(`${dir}${candidate}.md`)) !== null, NEW_DIAGRAM_NAME);
    const file = await this.app.vault.create(normalizePath(`${dir}${name}.md`), serializeNewNote({ text: STARTER, snapshots: [] }));
    await this.openAsDiagram(this.app.workspace.getLeaf(where), file);
  }

  // ------------------------------------------------------------------ export

  async saveExport(/** @type {DiagramView} */ view, /** @type {string} */ filename, /** @type {Blob} */ blob) {
    const path = await this.app.fileManager.getAvailablePathForAttachment(filename, view.file?.path ?? '');
    const file = /^(text\/|image\/svg)/.test(blob.type)
      ? await this.app.vault.create(path, await blob.text())
      : await this.app.vault.createBinary(path, await blob.arrayBuffer());
    new Notice(`Saved ${file.path}`);
  }

  // -------------------------------------------------------------- view state

  keepViewState(/** @type {string} */ path, /** @type {ViewState} */ state) {
    if (this.viewStates.set(path, state)) this.scheduleData();
  }

  scheduleData() {
    if (this.dataTimer !== null) window.clearTimeout(this.dataTimer);
    this.dataTimer = window.setTimeout(() => void this.flushData(), DATA_SAVE_MS);
  }

  async flushData() {
    if (this.dataTimer !== null) window.clearTimeout(this.dataTimer);
    this.dataTimer = null;
    await this.saveData({ viewState: this.viewStates.toJSON() });
  }

  forEachDiagram(/** @type {(view: DiagramView) => void} */ run) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof DiagramView) run(leaf.view);
    }
  }
}
