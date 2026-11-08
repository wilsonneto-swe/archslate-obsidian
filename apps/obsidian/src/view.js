// The diagram view: a TextFileView over a Markdown note, with the editor
// (packages/ui) filling it.
//
// Obsidian owns the file. It reads the note into setViewData(text, true), asks
// getViewData() for the text when it saves, and hands an outside change (a
// sync, git, another app) to setViewData(text, false). The view keeps:
//  - THE NOTE AROUND THE DIAGRAM: parseNote() splits off the frontmatter, any
//    text before the block, the line endings; serializeNote() puts them back.
//    A note opened and not edited is never written (OPEN-NEVER-WRITES).
//  - SAVE-OBSIDIAN-STYLE: every change asks for Obsidian's debounced save
//    (requestSave); closing the view, another note in the same tab and
//    quitting save too.
//  - OUTSIDE-CHANGE: the file's new text replaces the diagram as one undoable
//    step (Mod+Z brings back what was there), the frontmatter is taken as is.
//  - VIEW-STATE (view-state.js): camera and panels per note, restored on open.
//  - KEYS: the editor handles its keys on its own elements; the view's scope
//    claims Mod+S (save a version) and Mod+Z / Mod+Shift+Z (the diagram's
//    undo) before Obsidian's hotkeys while the view is focused.
//  - MOBILE: header buttons for Undo, Redo and Fit; Obsidian's edge swipes never
//    start on the canvas (data-ignore-swipe).
//  - POP-OUT WINDOWS: a view moved to another window keeps its editor, which
//    then observes from that window (handleResize). Elements Obsidian renders
//    there (the notes) belong to that window: they are checked with instanceOf.

import { Component, Keymap, MarkdownRenderer, Notice, Platform, Scope, TextFileView } from 'obsidian';
import { parseNote, serializeNote } from '../../../packages/core/document.js';
import { DiagramEditor } from '../../../packages/ui/editor.js';
import { ICON, PLUGIN_NAME, VIEW_CLASS, VIEW_TYPE } from './constants.js';

/** @typedef {import('obsidian').Modifier} Modifier */
/** @typedef {import('obsidian').TFile} TFile */
/** @typedef {import('obsidian').WorkspaceLeaf} WorkspaceLeaf */
/** @typedef {import('./main.js').default} ArchslatePlugin */
/** @typedef {import('../../../packages/types').DiagramDocument} DiagramDocument */
/** @typedef {import('../../../packages/types').EditorHost} EditorHost */
/** @typedef {import('../../../packages/types').Envelope} Envelope */

export class DiagramView extends TextFileView {
  constructor(/** @type {WorkspaceLeaf} */ leaf, /** @type {ArchslatePlugin} */ plugin) {
    super(leaf);
    this.plugin = plugin;
    /**
     * The editor, from the first setViewData() until the view closes.
     * @type {DiagramEditor | null}
     */
    this.editor = null;
    /**
     * The note around the diagram, as last read (see parseNote()).
     * @type {Envelope | null}
     */
    this.envelope = null;
    this.closed = false;
    /**
     * Owns what Obsidian's renderer made of the notes, unloaded when they are rendered again.
     * @type {Component | null}
     */
    this.notesComponent = null;
    this.navigation = true;

    this.scope = new Scope(this.app.scope);
    /**
     * Claims a key for the diagram: it runs `run`, unless there is no editor or the key goes to a text input.
     * @param {Modifier[]} modifiers
     * @param {string} key
     * @param {() => void} run
     */
    const claim = (modifiers, key, run) =>
      this.scope.register(modifiers, key, (event) => {
        if (!this.editor || this.isTyping(event)) return true;
        run();
        return false;
      });
    claim(['Mod'], 's', () => this.editor.timeline.openSave());
    claim(['Mod'], 'z', () => this.editor.undo());
    claim(['Mod', 'Shift'], 'z', () => this.editor.redo());
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return this.file?.basename ?? PLUGIN_NAME;
  }

  getIcon() {
    return ICON;
  }

  onOpen() {
    this.contentEl.addClass(VIEW_CLASS);
    this.register(this.contentEl.onWindowMigrated(() => this.editor?.handleResize()));
    this.addAction('file-text', 'Open as Markdown', () => this.plugin.openAsMarkdown(this.leaf));
    if (Platform.isMobile) {
      this.addAction('maximize', 'Fit diagram', () => this.editor?.canvas.fit(true));
      this.addAction('redo-2', 'Redo', () => this.editor?.redo());
      this.addAction('undo-2', 'Undo', () => this.editor?.undo());
    }
    return Promise.resolve();
  }

  onResize() {
    this.editor?.handleResize();
  }

  // Text inputs keep their own Mod+Z (the source pane has its own undo too).
  isTyping(/** @type {KeyboardEvent} */ event) {
    const target = event.targetNode;
    if (!target || !target.instanceOf(HTMLElement)) return false;
    return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
  }

  // ------------------------------------------------------------- the file

  getViewData() {
    if (!this.editor || !this.envelope) return this.data;
    return serializeNote(this.editor.document, this.envelope);
  }

  setViewData(/** @type {string} */ data, /** @type {boolean} */ clear) {
    this.data = data;
    const { doc, envelope } = parseNote(data);
    this.envelope = envelope;
    if (!this.editor) {
      this.mountEditor(doc);
      return;
    }
    if (clear) {
      this.editor.setDocument(doc);
      this.restoreViewState();
      return;
    }
    // An outside change. Our own saves never come back here.
    if (this.editor.applyExternal(doc)) {
      new Notice(`“${this.file?.basename ?? 'The diagram'}” changed on disk and was reloaded. Undo brings back what was here.`);
    }
  }

  clear() {
    // setViewData(…, true) follows and replaces the document.
  }

  mountEditor(/** @type {DiagramDocument} */ doc) {
    this.editor = new DiagramEditor(this.contentEl, this.host());
    this.editor.setDocument(doc);
    this.editor.canvas.stage.setAttribute('data-ignore-swipe', 'true');
    this.restoreViewState();
  }

  host() {
    return {
      load: () => Promise.resolve(parseNote(this.data).doc),
      save: () => {
        if (!this.closed) this.requestSave();
      },
      renderMarkdown: (/** @type {string} */ markdown, /** @type {HTMLElement} */ element) => this.renderNotes(markdown, element),
      saveFile: (/** @type {string} */ filename, /** @type {Blob} */ blob) => this.plugin.saveExport(this, filename, blob),
      fileName: () => this.file?.basename ?? 'diagram',
      notify: (/** @type {string} */ message) => new Notice(message),
      exportsDocument: false,
      appleKeys: Platform.isMacOS || Platform.isIosApp,
    };
  }

  // The notes below the diagram, through Obsidian's own renderer: links, tags,
  // embeds and callouts work as in any note.
  renderNotes(/** @type {string} */ markdown, /** @type {HTMLElement} */ element) {
    if (this.notesComponent) this.removeChild(this.notesComponent);
    this.notesComponent = this.addChild(new Component());
    element.empty();
    element.addClass('markdown-rendered');
    void MarkdownRenderer.render(this.app, markdown, element, this.file?.path ?? '', this.notesComponent);
    if (!element.dataset.links) {
      element.dataset.links = 'on';
      this.registerDomEvent(element, 'click', (event) => {
        const clicked = event.targetNode;
        const link = clicked && clicked.instanceOf(Element) ? clicked.closest('a.internal-link') : null;
        if (!link) return;
        event.preventDefault();
        const target = link.getAttribute('data-href') ?? link.getAttribute('href');
        if (target) void this.app.workspace.openLinkText(target, this.file?.path ?? '', Keymap.isModEvent(event));
      });
    }
  }

  // ------------------------------------------------------------ view state

  restoreViewState() {
    const path = this.file?.path;
    if (!this.editor || !path) return;
    this.editor.setViewState(this.plugin.viewStates.get(path) ?? {});
  }

  rememberViewState() {
    const path = this.file?.path;
    if (this.editor && path) this.plugin.keepViewState(path, this.editor.getViewState());
  }

  // Saves now: a pending debounced save is written at once.
  async saveNow() {
    if (!this.editor || this.closed) return;
    this.editor.saveNow();
    await this.save();
  }

  async onUnloadFile(/** @type {TFile} */ file) {
    this.rememberViewState();
    this.editor?.saveNow();
    await super.onUnloadFile(file);
  }

  // Closing the tab (or the tab moving to another kind of view) is where a
  // TextFileView writes its last change: FileView's close runs loadFile(null),
  // which calls onUnloadFile above and then save(true). That has to happen
  // while the editor still holds the document; only then is it taken down.
  async onClose() {
    this.rememberViewState();
    await super.onClose();
    this.closed = true;
    // A save Obsidian still has queued writes what was saved above.
    if (this.editor && this.envelope) this.data = serializeNote(this.editor.document, this.envelope);
    this.editor?.destroy({ save: false });
    this.editor = null;
    this.contentEl.empty();
  }
}
