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

import { Component, Keymap, MarkdownRenderer, Notice, Platform, Scope, TextFileView } from 'obsidian';
import { parseNote, serializeNote } from '../../../packages/core/document.js';
import { DiagramEditor } from '../../../packages/ui/editor.js';
import { ICON, PLUGIN_NAME, VIEW_CLASS, VIEW_TYPE } from './constants.js';

export class DiagramView extends TextFileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.editor = null;
    this.envelope = null;
    this.closed = false;
    this.notesComponent = null;
    this.navigation = true;

    this.scope = new Scope(this.app.scope);
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

  async onOpen() {
    this.contentEl.addClass(VIEW_CLASS);
    this.addAction('file-text', 'Open as Markdown', () => this.plugin.openAsMarkdown(this.leaf));
    if (Platform.isMobile) {
      this.addAction('maximize', 'Fit diagram', () => this.editor?.canvas.fit(true));
      this.addAction('redo-2', 'Redo', () => this.editor?.redo());
      this.addAction('undo-2', 'Undo', () => this.editor?.undo());
    }
  }

  // Text inputs keep their own Mod+Z (the source pane has its own undo too).
  isTyping(event) {
    const target = event.target;
    return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
  }

  // ------------------------------------------------------------- the file

  getViewData() {
    if (!this.editor || !this.envelope) return this.data;
    return serializeNote(this.editor.document, this.envelope);
  }

  setViewData(data, clear) {
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

  mountEditor(doc) {
    this.editor = new DiagramEditor(this.contentEl, this.host());
    this.editor.setDocument(doc);
    this.editor.canvas.stage.setAttribute('data-ignore-swipe', 'true');
    this.restoreViewState();
  }

  host() {
    return {
      load: async () => parseNote(this.data).doc,
      save: () => {
        if (!this.closed) this.requestSave();
      },
      renderMarkdown: (markdown, element) => this.renderNotes(markdown, element),
      saveFile: (filename, blob) => this.plugin.saveExport(this, filename, blob),
      fileName: () => this.file?.basename ?? 'diagram',
      notify: (message) => new Notice(message),
      exportsDocument: false,
      appleKeys: Platform.isMacOS || Platform.isIosApp,
    };
  }

  // The notes below the diagram, through Obsidian's own renderer: links, tags,
  // embeds and callouts work as in any note.
  renderNotes(markdown, element) {
    if (this.notesComponent) this.removeChild(this.notesComponent);
    this.notesComponent = this.addChild(new Component());
    element.empty();
    element.addClass('markdown-rendered');
    void MarkdownRenderer.render(this.app, markdown, element, this.file?.path ?? '', this.notesComponent);
    if (!element.dataset.links) {
      element.dataset.links = 'on';
      this.registerDomEvent(element, 'click', (event) => {
        const link = event.target instanceof Element ? event.target.closest('a.internal-link') : null;
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

  async onUnloadFile(file) {
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
