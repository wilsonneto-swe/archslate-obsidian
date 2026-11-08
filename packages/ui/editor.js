// The editor component. It owns exactly one piece of state that matters, the
// source text, plus saved versions. Everything on screen is derived from it:
//
//   text -> parse -> (diff against a version) -> layout -> SVG + source mirror
//
// The editor is host-agnostic. A host only has to load and save a document:
//
//   host.load(): Promise<{ text: string, snapshots: Snapshot[] }>
//   host.save(doc): void | Promise<void>
//   Snapshot = { id, name, text, createdAt }
//
// Optional host hooks:
//   host.renderMarkdown(markdown, element)   render the notes (Obsidian has its own)
//   host.saveFile(filename, blob)            where exports go (default: download)
//   host.fileName()                          base name for exports
//   host.notify(message, { error })          show a short message (default: toast)
//   host.serializeDocument(doc)              the document as a note (default: a new note)
//   host.exportsDocument                     false where the note already is the file (Obsidian)
//   host.appleKeys                           true to label shortcuts ⌘S rather than Ctrl+S
//
// The web shell backs this with localStorage; the Obsidian shell will back it
// with a vault file.

import { parse, flowAtLine, slugify } from '../core/parser.js';
import { unionModel, isEmptySummary } from '../core/diff.js';
import { serializeNewNote } from '../core/document.js';
import { ensureMarkdown } from '../core/edits.js';
import { flowView, walkable } from '../core/flows.js';
import { layoutDiagram } from '../core/layout.js';
import { Canvas } from './canvas.js';
import { CodePane } from './code-pane.js';
import { el, viewOf } from './dom.js';
import { createMeasurer } from './measure.js';
import { diagramSvg, downloadBlob, fileBaseName, svgToPng } from './export.js';
import { icon } from './icons.js';
import { useAppleKeys } from './keys.js';
import { NotesPanel } from './notes-panel.js';
import { Timeline, formatDate } from './timeline.js';

const SAVE_DELAY = 400;
// A diagram whose layout takes longer than this (well over a hundred
// components) is redrawn when typing pauses, not on every keystroke.
const SLOW_LAYOUT_MS = 40;
// Below this editor width the notes panel starts closed: the canvas needs the room.
const NOTES_MIN_WIDTH = 1080;

class History {
  constructor() {
    this.entries = [];
    this.index = -1;
  }

  reset(text) {
    this.entries = [{ text, selection: null, key: null, time: 0 }];
    this.index = 0;
  }

  // Consecutive typing within a short window collapses into one undo step.
  record(text, selection, key) {
    const now = Date.now();
    const top = this.entries[this.index];
    if (key && top?.key === key && now - top.time < 1000) {
      Object.assign(top, { text, selection, time: now });
      return;
    }
    this.entries.length = this.index + 1;
    this.entries.push({ text, selection, key, time: now });
    if (this.entries.length > 300) this.entries.shift();
    this.index = this.entries.length - 1;
  }

  get canUndo() {
    return this.index > 0;
  }

  get canRedo() {
    return this.index < this.entries.length - 1;
  }

  undo() {
    if (!this.canUndo) return null;
    this.index -= 1;
    this.entries[this.index].key = null;
    return this.entries[this.index];
  }

  redo() {
    if (!this.canRedo) return null;
    this.index += 1;
    return this.entries[this.index];
  }
}

const newId = () => window.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const sameSelection = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export class DiagramEditor {
  constructor(container, host) {
    this.host = host;
    this.text = '';
    this.snapshots = [];
    this.version = 'now';
    this.changes = false;
    this.baseOverride = null;
    this.selection = null;
    this.lastKind = 'service';
    this.activeFlow = null;
    this.flowSource = null;
    this.notesPreference = null;
    this.history = new History();
    useAppleKeys(host.appleKeys);

    this.code = new CodePane({
      onInput: (value) => this.commit({ text: value }, { source: 'code' }),
      onCaretLine: (line) => {
        this.followCaretFlow(line);
        this.select(this.model?.lineIndex.get(line) ?? null, { source: 'code' });
      },
      onUndo: () => this.undo(),
      onRedo: () => this.redo(),
      onEscape: () => this.canvas.focus(),
    });
    this.canvas = new Canvas(this);
    this.timeline = new Timeline(this);
    this.notesPanel = new NotesPanel(this);
    this.statusBar = el('div', { class: 'sd-statusbar', hidden: true });
    this.toast = el('div', { class: 'sd-toast', role: 'status', 'aria-live': 'polite', hidden: true });
    this.splitter = el('div', { class: 'sd-splitter', role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' });

    this.root = el(
      'div',
      { class: 'sd-editor' },
      this.code.root,
      this.splitter,
      el(
        'section',
        { class: 'sd-board' },
        this.statusBar,
        el('div', { class: 'sd-board-main' }, this.canvas.stage, this.notesPanel.root),
        this.timeline.root,
        this.toast,
      ),
    );
    this.host_ = el('div', { class: 'sd-editor-host' }, this.root);
    container.append(this.host_);
    this.measure = createMeasurer(this.root);
    // The window the editor lives in: an Obsidian pop-out window has its own
    // frames, observers and timers.
    this.win = viewOf(this.root);
    this.canvas.attach();

    this.root.addEventListener('keydown', (event) => this.onKeyDown(event));
    // The notes panel follows the room available while the user has not chosen.
    let lastOpen = null;
    this.resizeObserver = new this.win.ResizeObserver(() => {
      if (!this.model || this.notesPreference !== null) return;
      if (this.notesOpen !== lastOpen) {
        lastOpen = this.notesOpen;
        this.updateNotes();
        this.canvas.update();
      }
    });
    this.resizeObserver.observe(this.root);
    this.splitter.addEventListener('pointerdown', (event) => this.onSplitterDown(event));
    // Leaving the page writes a change still waiting for its save, and only
    // then: a tab left open must not write over what another tab stored since.
    this.flush = () => {
      if (this.saveTimer) this.saveNow();
    };
    this.win.addEventListener('pagehide', this.flush);
  }

  async init() {
    const doc = await this.host.load();
    this.setDocument(doc);
  }

  setDocument(doc) {
    // Forms and modes belong to the document that was open.
    this.canvas.closePopover();
    this.canvas.cancelRename();
    if (this.canvas.link) this.canvas.cancelLink();
    this.timeline.reset();
    this.text = doc.text ?? '';
    this.snapshots = Array.isArray(doc.snapshots) ? doc.snapshots : [];
    this.version = 'now';
    this.changes = false;
    this.baseOverride = null;
    this.selection = null;
    this.activeFlow = null;
    this.notesPreference = null;
    this.history.reset(this.text);
    this.refresh({ refit: true });
  }

  // The whole document: what a host stores and what a .sd file contains.
  get document() {
    return { text: this.text, snapshots: this.snapshots };
  }

  // Replaces the document (an opened file, say) and stores it right away.
  openDocument(doc) {
    this.setDocument(doc);
    this.saveNow();
  }

  notify(message, { error = false } = {}) {
    if (this.host.notify) {
      this.host.notify(message, { error });
      return;
    }
    this.win.clearTimeout(this.toastTimer);
    this.toast.textContent = message;
    this.toast.classList.toggle('is-error', error);
    this.toast.hidden = false;
    this.toastTimer = this.win.setTimeout(() => {
      this.toast.hidden = true;
    }, error ? 6000 : 3200);
  }

  // `save: false` when the host has already written the document (or must not).
  destroy({ save = true } = {}) {
    if (save) this.saveNow();
    this.win.clearTimeout(this.saveTimer);
    this.win.clearTimeout(this.toastTimer);
    if (this.frame) this.win.cancelAnimationFrame(this.frame);
    this.win.clearTimeout(this.layoutTimer);
    this.win.removeEventListener('pagehide', this.flush);
    this.resizeObserver.disconnect();
    this.canvas.destroy();
    this.host_.remove();
  }

  // ------------------------------------------------------------------- state

  get readOnly() {
    return this.version !== 'now';
  }

  snapshot(id) {
    return this.snapshots.find((s) => s.id === id) ?? null;
  }

  get activeText() {
    return this.readOnly ? this.snapshot(this.version)?.text ?? '' : this.text;
  }

  baseSnapshot() {
    if (!this.changes) return null;
    const override = this.baseOverride && this.baseOverride !== this.version && this.snapshot(this.baseOverride);
    if (override) return override;
    if (this.version === 'now') return this.snapshots.at(-1) ?? null;
    const index = this.snapshots.findIndex((s) => s.id === this.version);
    return index > 0 ? this.snapshots[index - 1] : null;
  }

  commit(result, { source = 'canvas', refit = false } = {}) {
    if (this.readOnly) return;
    const { text, select } = result;
    if (text === this.text) {
      if (select !== undefined && source !== 'code') this.select(select);
      return;
    }
    this.text = text;
    if (select !== undefined) this.selection = select;
    this.history.record(text, this.selection, source === 'code' ? 'code' : null);
    this.refresh({ source, refit });
    // Something added or picked from the canvas stays in view, and in the source.
    if (select && source !== 'code') {
      this.canvas.ensureVisible(select);
      this.code.revealLine(this.lineOf(select));
    }
    this.scheduleSave();
  }

  undo() {
    if (this.readOnly) return;
    const entry = this.history.undo();
    if (entry) this.restoreEntry(entry);
  }

  redo() {
    if (this.readOnly) return;
    const entry = this.history.redo();
    if (entry) this.restoreEntry(entry);
  }

  restoreEntry(entry) {
    this.text = entry.text;
    this.selection = entry.selection;
    this.refresh();
    this.scheduleSave();
  }

  select(selection, { source = 'canvas' } = {}) {
    const next = selection ?? null;
    if (sameSelection(next, this.selection)) return;
    this.selection = next;
    this.canvas.setSelection(next);
    this.updateCode();
    if (source !== 'code' && next) this.code.revealLine(this.lineOf(next));
  }

  lineOf(selection) {
    if (!selection || !this.model) return -1;
    if (selection.type === 'node') return this.model.nodeById.get(selection.id)?.line ?? -1;
    if (selection.type === 'edge') return this.model.edgeByKey.get(selection.key)?.line ?? -1;
    if (selection.type === 'group') return this.model.groupById.get(selection.id)?.line ?? -1;
    if (selection.type === 'note') return this.model.noteByKey.get(selection.key)?.line ?? -1;
    return -1;
  }

  validateSelection() {
    const sel = this.selection;
    if (!sel) return;
    const m = this.renderModel;
    const alive =
      (sel.type === 'node' && m.nodeById.has(sel.id)) ||
      (sel.type === 'edge' && m.edgeByKey.has(sel.key)) ||
      (sel.type === 'group' && m.groupById.has(sel.id)) ||
      (sel.type === 'note' && m.noteByKey.has(sel.key));
    if (!alive) this.selection = null;
  }

  // --------------------------------------------------------------- rendering

  refresh({ source = 'canvas', refit = false } = {}) {
    this.model = parse(this.activeText);
    if (this.activeFlow && !this.model.flowById.has(this.activeFlow)) this.activeFlow = null;
    const base = this.baseSnapshot();
    if (base) {
      const union = unionModel(parse(base.text), this.model);
      this.renderModel = union;
      this.summary = union.summary;
    } else {
      this.renderModel = (this.activeFlow && flowView(this.model, this.activeFlow)) || this.model;
      this.summary = null;
    }
    this.validateSelection();
    this.updateCode();
    this.timeline.update();
    this.updateStatusBar();

    // Typing re-lays out (and redraws the notes) at most once per frame; canvas
    // actions render now so their follow-up UI (handles, toolbars) has fresh
    // geometry.
    if (source === 'code' && this.layout) {
      this.pendingRefit ||= refit;
      const draw = () => {
        this.frame = null;
        this.layoutTimer = null;
        this.renderCanvas(this.pendingRefit);
        this.pendingRefit = false;
      };
      if (this.layoutMs > SLOW_LAYOUT_MS) {
        this.win.clearTimeout(this.layoutTimer);
        this.layoutTimer = this.win.setTimeout(draw, Math.min(800, 150 + this.layoutMs));
      } else if (!this.frame) {
        this.frame = this.win.requestAnimationFrame(draw);
      }
    } else {
      this.renderCanvas(refit);
    }
  }

  renderCanvas(refit) {
    if (this.frame) {
      this.win.cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    if (this.layoutTimer) {
      this.win.clearTimeout(this.layoutTimer);
      this.layoutTimer = null;
    }
    this.updateNotes();
    const started = this.win.performance.now();
    this.layout = layoutDiagram(this.renderModel, { measureText: this.measure });
    this.layoutMs = this.win.performance.now() - started;
    this.canvas.renderer.selection = this.selection;
    this.canvas.update({ refit });
    const focus = this.pendingFocus;
    this.pendingFocus = null;
    if (focus === 'flow' && this.activeFlow) this.focusFlow();
    else if (focus === 'all') this.canvas.fit(true);
  }

  updateCode() {
    const marks = new Map();
    const mark = (line, cls) => {
      if (Number.isInteger(line)) marks.set(line, `${marks.get(line) ?? ''} ${cls}`.trim());
    };
    if (this.summary) {
      const { nodes, edges, groups, notes } = this.renderModel;
      for (const item of [...nodes, ...edges, ...groups, ...notes]) {
        if (item.status === 'added' || item.status === 'changed') mark(item.line, `is-${item.status}`);
      }
    }
    const sel = this.selection;
    if (sel) {
      mark(this.lineOf(sel), 'is-selected');
      if (sel.type === 'group') mark(this.model.groupById.get(sel.id)?.endLine, 'is-selected');
    }

    const viewing = this.readOnly ? this.snapshot(this.version) : null;
    this.code.update({
      text: this.activeText,
      model: this.model,
      readOnly: this.readOnly,
      lineMarks: marks,
      banner: viewing ? el('span', {}, icon('bookmark', 14), ` ${viewing.name} (read-only)`) : null,
      onJump: (line, column) => this.code.jumpTo(line, column),
    });
  }

  updateStatusBar() {
    const parts = [];
    const viewing = this.readOnly ? this.snapshot(this.version) : null;
    if (viewing) {
      parts.push(
        el(
          'div',
          { class: 'sd-status-group' },
          el('span', { class: 'sd-status-title' }, icon('bookmark', 14), el('span', { text: viewing.name })),
          el('span', { class: 'sd-muted', text: `saved ${formatDate(viewing.createdAt)} · read-only` }),
          el('button', { type: 'button', class: 'sd-btn sd-primary', onclick: () => this.restoreVersion(viewing.id) }, icon('restore', 14), el('span', { text: 'Restore' })),
          el('button', { type: 'button', class: 'sd-btn', onclick: () => this.viewVersion('now') }, icon('back', 14), el('span', { text: 'Back to now' })),
        ),
      );
    }

    if (this.changes) {
      const base = this.baseSnapshot();
      const targetName = viewing ? viewing.name : 'Now';
      if (!base) {
        parts.push(el('span', { class: 'sd-muted', text: `${targetName} is the first version, so there is nothing earlier to compare with.` }));
      } else {
        const select = el(
          'select',
          {
            class: 'sd-select',
            'aria-label': 'Compare against',
            onchange: (event) => this.setBase(event.target.value),
          },
          this.snapshots
            .filter((s) => s.id !== this.version)
            .map((s) => el('option', { value: s.id, text: s.name, selected: s.id === base.id })),
        );
        const counts = (label, bucket) => {
          const chips = [];
          if (bucket.added) chips.push(el('span', { class: 'sd-chip is-added', text: `+${bucket.added}` }));
          if (bucket.removed) chips.push(el('span', { class: 'sd-chip is-removed', text: `−${bucket.removed}` }));
          if (bucket.changed) chips.push(el('span', { class: 'sd-chip is-changed', text: `~${bucket.changed}` }));
          return chips.length ? el('span', { class: 'sd-status-counts' }, el('span', { class: 'sd-muted', text: label }), chips) : null;
        };
        const s = this.summary;
        parts.push(
          el(
            'div',
            { class: 'sd-status-group' },
            el('span', { class: 'sd-status-title' }, icon('diff', 14), el('span', { text: 'Changes' })),
            select,
            el('span', { class: 'sd-muted', text: `→ ${targetName}` }),
            isEmptySummary(s)
              ? el('span', { class: 'sd-muted', text: 'no differences' })
              : [
                  counts('components', s.nodes),
                  counts('links', s.edges),
                  counts('groups', s.groups),
                  counts('notes', s.notes),
                  counts('flows', s.flows),
                  s.directionChanged ? el('span', { class: 'sd-chip is-changed', text: 'direction changed' }) : null,
                  s.markdownChanged ? el('span', { class: 'sd-chip is-changed', text: 'markdown edited' }) : null,
                ],
            el(
              'button',
              { type: 'button', class: 'sd-btn sd-btn-icon', title: 'Hide changes (C)', 'aria-label': 'Hide changes', onclick: () => this.toggleChanges() },
              icon('close', 14),
            ),
          ),
        );
      }
    }

    const flow = !this.summary && this.activeFlow ? this.model.flowById.get(this.activeFlow) : null;
    if (flow) {
      const steps = walkable(flow).length;
      parts.push(
        el(
          'div',
          { class: 'sd-status-group' },
          el('span', { class: 'sd-status-title' }, icon('flow', 14), el('span', { text: flow.label })),
          el('span', { class: 'sd-muted', text: `${steps} step${steps === 1 ? '' : 's'} · numbers follow the order in the source` }),
          el(
            'button',
            { type: 'button', class: 'sd-btn sd-btn-icon', title: 'Leave the flow (Esc)', 'aria-label': 'Leave the flow', onclick: () => this.setFlow(null) },
            icon('close', 14),
          ),
        ),
      );
    }

    this.statusBar.replaceChildren(...parts);
    this.statusBar.hidden = parts.length === 0;
  }

  // ------------------------------------------------------------- flows, notes

  setFlow(id, source = 'user') {
    const next = id && this.model.flowById.has(id) ? id : null;
    if (next === this.activeFlow) {
      this.flowSource = next ? source : null;
      return;
    }
    const wasFlow = this.activeFlow;
    this.activeFlow = next;
    this.flowSource = next ? source : null;
    if (next) {
      this.changes = false;
      this.baseOverride = null;
    }
    // The camera follows the walkthrough, and goes back to the whole diagram after it.
    this.pendingFocus = next ? 'flow' : wasFlow && !this.canvas.autoFit ? 'all' : null;
    this.refresh({ source: source === 'code' ? 'code' : 'canvas' });
    this.keepFocus();
  }

  focusFlow() {
    const ids = this.renderModel.nodes.filter((node) => node.flow === 'in').map((node) => node.id);
    const boxes = [
      ...ids.map((id) => this.layout.nodes.get(id)),
      ...this.renderModel.edges.filter((edge) => edge.flow === 'in').map((edge) => this.layout.edges.get(edge.key)?.label),
    ].filter(Boolean);
    if (!boxes.length) return;
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    const right = Math.max(...boxes.map((b) => b.x + b.w));
    const bottom = Math.max(...boxes.map((b) => b.y + b.h));
    this.canvas.focusRect({ x: x - 24, y: y - 24, w: right - x + 48, h: bottom - y + 48 });
  }

  cycleFlow() {
    const flows = this.model.flows;
    if (flows.length === 0) return;
    const index = flows.findIndex((flow) => flow.id === this.activeFlow);
    this.setFlow(index + 1 < flows.length ? flows[index + 1].id : null);
  }

  // Putting the caret inside a flow block shows that flow; leaving the block
  // hides it again, unless it was opened from the canvas.
  followCaretFlow(line) {
    if (!this.model || this.changes) return;
    const flow = flowAtLine(this.model, line);
    if (flow) this.setFlow(flow.id, 'code');
    else if (this.activeFlow && this.flowSource === 'code') this.setFlow(null, 'code');
  }

  // Open when there are notes and room for them, unless the user said otherwise.
  get notesOpen() {
    if (this.notesPreference !== null) return this.notesPreference;
    const width = this.root.clientWidth;
    return this.model?.markdown.trim() !== '' && (width === 0 || width >= NOTES_MIN_WIDTH);
  }

  toggleNotes(force) {
    const open = force ?? !this.notesOpen;
    if (open && this.model.markdownLine < 0 && !this.readOnly) {
      // No notes yet: start a section in the source and put the caret there.
      const { text, line } = ensureMarkdown(this.text);
      this.notesPreference = true;
      this.commit({ text, select: this.selection });
      if (this.sourceHidden) this.toggleSource(false);
      this.code.jumpTo(line);
      return;
    }
    this.notesPreference = open;
    this.updateNotes();
    this.canvas.update();
  }

  editMarkdown() {
    if (this.readOnly) return;
    if (this.model.markdownLine < 0) {
      this.toggleNotes(true);
      return;
    }
    if (this.sourceHidden) this.toggleSource(false);
    this.code.jumpTo(this.model.lines.length - 1);
  }

  updateNotes() {
    this.notesPanel.update({
      markdown: this.model.markdown,
      open: this.notesOpen,
      changed: Boolean(this.summary?.markdownChanged),
      readOnly: this.readOnly,
    });
  }

  // ------------------------------------------------------------------ export

  fileName() {
    let name = this.host.fileName?.() || fileBaseName(this.text);
    const viewing = this.readOnly ? this.snapshot(this.version) : null;
    if (viewing) name += `-${slugify(viewing.name).replace(/_/g, '-') || 'version'}`;
    if (this.summary) name += '-changes';
    else if (this.activeFlow) name += `-${this.activeFlow.replace(/_/g, '-')}`;
    return name;
  }

  saveFile(filename, blob) {
    if (this.host.saveFile) return this.host.saveFile(filename, blob);
    downloadBlob(blob, filename);
    return undefined;
  }

  // Exports exactly what is on screen (a version, the changes view, a flow),
  // without the selection highlight.
  async exportImage(format) {
    if (this.canvas.link) this.canvas.cancelLink();
    const renderer = this.canvas.renderer;
    const selection = renderer.selection;
    renderer.setSelection(null);
    const background = viewOf(this.canvas.stage).getComputedStyle(this.canvas.stage).backgroundColor;
    const image = diagramSvg(renderer, this.layout, background);
    renderer.setSelection(selection);
    const name = this.fileName();
    try {
      if (format === 'svg') {
        await this.saveFile(`${name}.svg`, new Blob([image.text], { type: 'image/svg+xml' }));
      } else {
        await this.saveFile(`${name}.png`, await svgToPng(image, 2));
      }
    } catch (error) {
      this.notify(`Export failed: ${error.message}`, { error: true });
    }
  }

  // The whole document, versions included, as the Markdown note that
  // Obsidian opens as a diagram and that the web app can open again.
  async exportDocument() {
    const name = this.host.fileName?.() || fileBaseName(this.text);
    const note = this.host.serializeDocument ? this.host.serializeDocument(this.document) : serializeNewNote(this.document);
    try {
      await this.saveFile(`${name}.md`, new Blob([note], { type: 'text/markdown' }));
    } catch (error) {
      this.notify(`Export failed: ${error.message}`, { error: true });
    }
  }

  // ---------------------------------------------------------- host plumbing

  // The file changed outside the editor (a sync, git, another app): its text
  // replaces ours as one undoable step, so nothing typed here is lost.
  applyExternal(doc) {
    const sameVersions = JSON.stringify(doc.snapshots) === JSON.stringify(this.snapshots);
    if (doc.text === this.text && sameVersions) return false;
    // What was waiting to be saved is replaced (it stays one Undo away).
    this.win.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.snapshots = doc.snapshots;
    if (this.version !== 'now' && !this.snapshot(this.version)) this.version = 'now';
    if (this.baseOverride && !this.snapshot(this.baseOverride)) this.baseOverride = null;
    if (this.snapshots.length === 0) this.changes = false;
    if (doc.text !== this.text) {
      this.text = doc.text;
      this.history.record(doc.text, this.selection, null);
    }
    this.refresh();
    return true;
  }

  get sourceHidden() {
    return this.root.classList.contains('is-source-hidden');
  }

  toggleSource(force) {
    const hidden = force ?? !this.sourceHidden;
    this.root.classList.toggle('is-source-hidden', hidden);
    this.canvas.update();
  }

  // What a host keeps per document so it opens again as it was left.
  getViewState() {
    const { k, tx, ty } = this.canvas.view;
    return {
      view: this.canvas.autoFit ? null : { k, tx, ty },
      codeWidth: this.root.style.getPropertyValue('--sd-code-width') || null,
      sourceHidden: this.sourceHidden,
      notes: this.notesPreference,
    };
  }

  setViewState(state) {
    if (!state || typeof state !== 'object') return;
    if (typeof state.codeWidth === 'string' && /^\d+(\.\d+)?(px|%)$/.test(state.codeWidth)) {
      this.root.style.setProperty('--sd-code-width', state.codeWidth);
    }
    this.root.classList.toggle('is-source-hidden', state.sourceHidden === true);
    if (typeof state.notes === 'boolean') this.notesPreference = state.notes;
    this.updateNotes();
    const view = state.view;
    if (view && [view.k, view.tx, view.ty].every(Number.isFinite)) {
      this.canvas.autoFit = false;
      this.canvas.setView({ k: Math.min(3, Math.max(0.15, view.k)), tx: view.tx, ty: view.ty });
    } else {
      this.canvas.fit(false);
    }
    this.canvas.update();
  }

  // ---------------------------------------------------------------- versions

  saveVersion(name) {
    this.snapshots.push({
      id: newId(),
      name: name || `v${this.snapshots.length + 1}`,
      text: this.text,
      createdAt: new Date().toISOString(),
    });
    this.baseOverride = null;
    this.refresh();
    this.saveNow();
  }

  renameVersion(id, name) {
    const snapshot = this.snapshot(id);
    if (!snapshot) return;
    snapshot.name = name;
    this.refresh();
    this.saveNow();
  }

  deleteVersion(id) {
    this.snapshots = this.snapshots.filter((s) => s.id !== id);
    if (this.version === id) this.version = 'now';
    if (this.baseOverride === id) this.baseOverride = null;
    if (this.snapshots.length === 0) this.changes = false;
    this.refresh();
    this.saveNow();
  }

  viewVersion(id) {
    if (id !== 'now' && !this.snapshot(id)) return;
    if (id === this.version) return;
    this.version = id;
    this.selection = null;
    this.canvas.closePopover();
    if (this.canvas.link) this.canvas.cancelLink();
    if (this.baseOverride === id) this.baseOverride = null;
    this.refresh({ refit: true });
    this.keepFocus();
  }

  // Restoring never loses work: unless the current text is already saved as
  // a version, it is saved first. It is also a normal, undoable edit.
  restoreVersion(id) {
    const snapshot = this.snapshot(id);
    if (!snapshot) return;
    this.version = 'now';
    if (this.text !== snapshot.text) {
      if (!this.snapshots.some((s) => s.text === this.text)) {
        this.snapshots.push({
          id: newId(),
          name: `Before restoring ${snapshot.name}`,
          text: this.text,
          createdAt: new Date().toISOString(),
        });
      }
      this.commit({ text: snapshot.text, select: null }, { refit: true });
      this.saveNow();
    } else {
      this.refresh({ refit: true });
    }
    this.keepFocus();
  }

  toggleChanges() {
    if (this.snapshots.length === 0) return;
    this.changes = !this.changes;
    if (!this.changes) this.baseOverride = null;
    else this.activeFlow = null;
    this.refresh();
    this.keepFocus();
  }

  setBase(id) {
    if (!this.snapshot(id) || id === this.version) return;
    this.baseOverride = id;
    this.changes = true;
    this.activeFlow = null;
    this.refresh();
    this.keepFocus();
  }

  // ---------------------------------------------------------------- plumbing

  // A button that started an action is drawn again by it, and focus falls to
  // the page: the canvas takes it, so the keys keep working.
  keepFocus() {
    const doc = this.root.ownerDocument;
    const active = doc.activeElement;
    if (!active || active === doc.body || !active.isConnected) this.canvas.focus();
  }

  // Versions are saved at once (saveNow): an outside change arriving in the
  // next moment then finds them already written.
  scheduleSave() {
    this.win.clearTimeout(this.saveTimer);
    this.saveTimer = this.win.setTimeout(() => this.saveNow(), SAVE_DELAY);
  }

  saveNow() {
    this.win.clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.host.save(this.document);
  }

  onKeyDown(event) {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === 's') {
      event.preventDefault();
      this.timeline.openSave();
      return;
    }
    const target = event.target;
    if (target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (key === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.redo();
      else this.undo();
    } else if (key === 'y') {
      event.preventDefault();
      this.redo();
    }
  }

  onSplitterDown(event) {
    event.preventDefault();
    const bounds = this.root.getBoundingClientRect();
    this.splitter.setPointerCapture(event.pointerId);
    const move = (e) => {
      const width = Math.min(bounds.width * 0.7, Math.max(220, e.clientX - bounds.left));
      this.root.style.setProperty('--sd-code-width', `${width}px`);
    };
    const up = () => {
      this.splitter.removeEventListener('pointermove', move);
      this.splitter.removeEventListener('pointerup', up);
    };
    this.splitter.addEventListener('pointermove', move);
    this.splitter.addEventListener('pointerup', up);
  }
}

export async function mountEditor(container, host) {
  const editor = new DiagramEditor(container, host);
  await editor.init();
  return editor;
}
