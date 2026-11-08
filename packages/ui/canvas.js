// The interactive diagram: pan and zoom, selection, (+) handles, link mode,
// contextual toolbars and popovers. Nothing here owns diagram state. Every
// action turns into an edit from core/edits.js and goes through editor.commit().

import * as edits from '../core/edits.js';
import { walkable } from '../core/flows.js';
import { KINDS, KIND_NAMES, OPS, OP_LIST, defaultLinkOp } from '../core/kinds.js';
import { el, viewOf } from './dom.js';
import { icon } from './icons.js';
import { isComposing, modKey, modName } from './keys.js';
import { DiagramRenderer } from './renderer.js';

/** @typedef {import('../types').AddFormOptions} AddFormOptions */
/** @typedef {import('./editor.js').DiagramEditor} DiagramEditor */
/** @typedef {import('../types').CanvasLink} CanvasLink */
/** @typedef {import('../types').CanvasView} CanvasView */
/** @typedef {import('../types').ChromeAlign} ChromeAlign */
/** @typedef {import('../types').EditResult} EditResult */
/** @typedef {import('../types').Layout} Layout */
/** @typedef {import('../types').LinkDirection} LinkDirection */
/** @typedef {import('../types').LinkOp} LinkOp */
/** @typedef {import('../types').Model} Model */
/** @typedef {import('../types').NoteItemBox} NoteItemBox */
/** @typedef {import('../types').Point} Point */
/** @typedef {import('../types').Rect} Rect */
/** @typedef {import('../types').Selection} Selection */

/**
 * A click on a button made by button(): `currentTarget` is that button.
 * @typedef {PointerEvent & { currentTarget: HTMLButtonElement }} ButtonClick
 */

/**
 * button()'s options. `label` is the tooltip and the accessible name;
 * `pressed` makes it a toggle (aria-pressed), left out when undefined.
 * @typedef {{ iconName?: string, label: string, onClick: (event: ButtonClick) => void, className?: string, text?: string, pressed?: boolean, disabled?: boolean }} ButtonOptions
 */

/**
 * kindGrid()'s options: a radio per kind (and 'group' with `includeGroup`),
 * `value` checked; `onChange` gets the kind picked.
 * @typedef {{ name: string, value: string, includeGroup: boolean, onChange: (kind: string) => void }} KindGridOptions
 */

/**
 * An event the stage listens to (a pointer, a double click, the wheel). It
 * comes from the canvas's own elements, so its target is an element.
 * @template {Event} E
 * @typedef {E & { target: Element }} StageEvent
 */

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;
const MAX_FIT_ZOOM = 1.1;
const DRAG_THRESHOLD = 4;

/** @returns {Array<[string, string]>} the help popover's rows: keys, and what they do */
const shortcuts = () => [
  ['Tab / ⇧Tab', 'Add a component after / before the selection'],
  ['Drag a (+)', 'Link to an existing component'],
  ['L', 'Link from the selection (then click or arrows + Enter)'],
  ['Enter', 'Rename / edit link label or note'],
  ['T', 'Change component type'],
  ['D', 'Details: instances (x3) and properties'],
  ['N', 'Add a sticky note to the component'],
  ['E / R', 'Cycle request → event → connection / reverse link'],
  ['Delete / ⌫', 'Delete selection (groups keep their contents)'],
  ['Arrows', 'Move selection'],
  ['A / G', 'Add component / group'],
  ['W', 'Walk through the next flow'],
  ['M', 'Show / hide the markdown notes'],
  ['\\', 'Show / hide the source'],
  [`${modKey('Z')} / ${modKey('Z', { shift: true })}`, 'Undo / redo'],
  [modKey('S'), 'Save a version'],
  ['C', 'Show changes against the previous version'],
  ['F / 0', 'Fit / 100% zoom'],
  ['Esc', 'Cancel, close, deselect'],
];

/** @type {Record<LinkOp, string>} */
const OP_TEXT = { '->': '→ Request', '-->': '⇢ Event', '<->': '⇄ Connection' };

/**
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
const isTypingTarget = (target) => {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
};

/**
 * @param {ButtonOptions} options
 * @returns {HTMLButtonElement}
 */
function button({ iconName, label, onClick, className = '', text, pressed, disabled }) {
  return el(
    'button',
    {
      type: 'button',
      class: `sd-btn ${className}`.trim(),
      title: label,
      'aria-label': label,
      'aria-pressed': pressed === undefined ? null : String(pressed),
      disabled,
      onclick: onClick,
    },
    iconName ? icon(iconName) : null,
    text ? el('span', { text }) : null,
  );
}

/**
 * @param {KindGridOptions} options
 * @returns {HTMLFieldSetElement}
 */
function kindGrid({ name, value, includeGroup, onChange }) {
  const kinds = includeGroup ? [...KIND_NAMES, 'group'] : KIND_NAMES;
  return el(
    'fieldset',
    { class: 'sd-kinds' },
    el('legend', { class: 'sd-visually-hidden', text: 'Type' }),
    kinds.map((kind) => {
      const label = kind === 'group' ? 'Group' : KINDS[kind].label;
      const category = kind === 'group' ? 'group' : KINDS[kind].category;
      return el(
        'label',
        { class: `sd-kind sd-cat-${category}`, title: kind === 'group' ? 'Group (a box)' : `${label} (${kind})` },
        el('input', {
          type: 'radio',
          name,
          value: kind,
          checked: kind === value,
          onchange: (/** @type {Event & { target: HTMLInputElement }} */ event) => onChange(event.target.value),
        }),
        el('span', { class: 'sd-kind-face' }, icon(kind, 18), el('span', { class: 'sd-kind-name', text: kind })),
      );
    }),
  );
}

export class Canvas {
  constructor(/** @type {DiagramEditor} */ editor) {
    this.editor = editor;
    this.renderer = new DiagramRenderer();
    /** @type {CanvasView} */
    this.view = { k: 1, tx: 0, ty: 0 };
    /** True while the view follows the diagram (fit), false once the user pans or zooms. */
    this.autoFit = true;
    /** @type {CanvasLink | null} */
    this.link = null;
    /**
     * The open popover; `anchor` is the button that opened it (pressing it again closes it).
     * @type {{ element: HTMLDivElement, onClose: (() => void) | undefined, anchor: HTMLElement | null } | null}
     */
    this.popover = null;
    /**
     * The toolbars and handles around the selection, each with the [anchor, align] places it may take.
     * @type {Array<{ element: HTMLElement, options: Array<[() => Point, ChromeAlign]> }>}
     */
    this.chromeItems = [];

    this.chrome = el('div', { class: 'sd-chrome' });
    this.popoverHost = el('div', { class: 'sd-popover-host' });
    this.emptyState = el(
      'div',
      { class: 'sd-empty', hidden: true },
      el(
        'button',
        { type: 'button', class: 'sd-empty-add', title: 'Add component (A)', 'aria-label': 'Add component', onclick: () => this.openAddForm({}) },
        icon('plus', 22),
      ),
      el('p', { text: 'Add your first component' }),
      el('p', { class: 'sd-muted' }, 'or type ', el('code', { text: 'service api "My API"' }), ' in the source'),
    );

    this.directionButton = button({ iconName: 'right', label: 'Flow direction', onClick: () => this.toggleDirection() });
    this.undoButton = button({ iconName: 'undo', label: `Undo (${modKey('Z')})`, onClick: () => editor.undo() });
    this.redoButton = button({ iconName: 'redo', label: `Redo (${modKey('Z', { shift: true })})`, onClick: () => editor.redo() });
    this.notesButton = button({ iconName: 'doc', text: 'Notes', label: 'Markdown notes (M)', onClick: () => editor.toggleNotes() });
    this.sourceButton = button({ iconName: 'code', label: 'Show or hide the source (\\)', onClick: () => editor.toggleSource() });
    this.editTools = el(
      'span',
      { class: 'sd-toolgroup' },
      button({ iconName: 'plus', text: 'Component', label: 'Add component (A)', onClick: () => this.openAddForm({}) }),
      button({ iconName: 'group', text: 'Group', label: 'Add group (G)', onClick: () => this.openAddForm({ kind: 'group' }) }),
      el('span', { class: 'sd-sep' }),
      this.undoButton,
      this.redoButton,
      el('span', { class: 'sd-sep' }),
      this.directionButton,
    );
    this.toolbar = el(
      'div',
      { class: 'sd-floating sd-topbar' },
      this.sourceButton,
      this.editTools,
      this.notesButton,
      button({ iconName: 'download', text: 'Export', label: 'Export image or file', onClick: (event) => this.toggleExport(event.currentTarget) }),
      button({ iconName: 'help', label: 'Keyboard shortcuts (?)', onClick: (event) => this.toggleHelp(event.currentTarget) }),
    );
    this.flowbar = el('div', { class: 'sd-floating sd-flowbar', hidden: true });

    this.zoomLabel = el('button', {
      type: 'button',
      class: 'sd-btn sd-zoom-label',
      title: 'Reset to 100% (0)',
      onclick: () => this.zoomTo(1),
    });
    this.zoombar = el(
      'div',
      { class: 'sd-floating sd-zoombar' },
      button({ iconName: 'zoomOut', label: 'Zoom out (-)', onClick: () => this.zoomBy(1 / 1.2) }),
      this.zoomLabel,
      button({ iconName: 'zoomIn', label: 'Zoom in (+)', onClick: () => this.zoomBy(1.2) }),
      button({ iconName: 'fit', label: 'Fit diagram (F)', onClick: () => this.fit(true) }),
    );

    this.stage = el(
      'div',
      { class: 'sd-stage', tabindex: 0, 'aria-label': 'Diagram canvas' },
      this.renderer.svg,
      this.emptyState,
      this.chrome,
      this.toolbar,
      this.flowbar,
      this.zoombar,
      this.popoverHost,
    );

    this.stage.addEventListener('pointerdown', (/** @type {StageEvent<PointerEvent>} */ e) => this.onPointerDown(e));
    this.stage.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.stage.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.stage.addEventListener('pointercancel', (e) => {
      this.liftPointer(e);
      this.endDrag();
    });
    this.stage.addEventListener('dblclick', (/** @type {StageEvent<MouseEvent>} */ e) => this.onDoubleClick(e));
    this.stage.addEventListener('wheel', (/** @type {StageEvent<WheelEvent>} */ e) => this.onWheel(e), { passive: false });
    this.stage.addEventListener('keydown', (e) => this.onKeyDown(e));
    // Touch points down on the canvas, for a pinch.
    /** @type {Map<number, Point>} */
    this.pointers = new Map();
    /**
     * A two-finger pinch: the fingers' first distance and midpoint, and the view then.
     * @type {{ distance: number, mid: Point, view: CanvasView } | null}
     */
    this.pinch = null;
  }

  // Called once the canvas is in the page, and again when it has moved to
  // another window: the observer comes from the window the canvas lives in
  // (an Obsidian pop-out window has its own).
  attach() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = new (viewOf(this.stage).ResizeObserver)(() => {
      if (this.autoFit) this.fit(false);
      else this.positionChrome();
    });
    this.resizeObserver.observe(this.stage);
  }

  destroy() {
    this.resizeObserver?.disconnect();
  }

  get model() {
    return this.editor.model;
  }

  get layout() {
    return this.editor.layout;
  }

  get readOnly() {
    return this.editor.readOnly;
  }

  // ---------------------------------------------------------------- rendering

  update(/** @type {{ refit?: boolean }} */ { refit = false } = {}) {
    const { renderModel, layout } = this.editor;
    this.renderer.update(renderModel, layout);
    const empty = renderModel.nodes.length === 0 && renderModel.groups.length === 0;
    this.emptyState.hidden = !empty || this.readOnly;
    this.stage.classList.toggle('is-readonly', this.readOnly);
    this.editTools.hidden = this.readOnly;
    this.notesButton.setAttribute('aria-pressed', String(this.editor.notesOpen));
    this.sourceButton.setAttribute('aria-pressed', String(!this.editor.sourceHidden));
    this.notesButton.hidden = this.readOnly && !this.model.markdown.trim();
    this.renderFlowbar();
    this.directionButton.replaceChildren(icon(this.model.direction === 'down' ? 'down' : 'right'));
    this.directionButton.title = this.model.direction === 'down' ? 'Flow: top to bottom' : 'Flow: left to right';
    this.undoButton.disabled = !this.editor.history.canUndo;
    this.redoButton.disabled = !this.editor.history.canRedo;

    if (refit) this.autoFit = true;
    if (this.autoFit) this.fit(!refit);
    if (this.link && !this.model.nodeById.has(this.link.anchor)) this.cancelLink();
    this.renderChrome();
  }

  setSelection(/** @type {Selection | null} */ selection) {
    this.renderer.setSelection(selection);
    this.renderChrome();
    this.ensureVisible(selection);
  }

  // --------------------------------------------------------------- view math

  setView(/** @type {CanvasView} */ view, /** @type {boolean} */ animate = false) {
    this.view = view;
    this.renderer.viewport.classList.toggle('is-animating', animate);
    if (animate) {
      window.clearTimeout(this.animTimer);
      this.animTimer = window.setTimeout(() => this.renderer.viewport.classList.remove('is-animating'), 320);
    }
    this.renderer.setView(view);
    const size = 22 * view.k;
    this.stage.style.setProperty('--sd-grid-size', `${size}px`);
    this.stage.style.setProperty('--sd-grid-x', `${view.tx}px`);
    this.stage.style.setProperty('--sd-grid-y', `${view.ty}px`);
    this.zoomLabel.textContent = `${Math.round(view.k * 100)}%`;
    this.positionChrome();
  }

  toScreen(/** @type {Point} */ point) {
    const { k, tx, ty } = this.view;
    return { x: point.x * k + tx, y: point.y * k + ty };
  }

  toWorld(/** @type {number} */ clientX, /** @type {number} */ clientY) {
    const rect = this.stage.getBoundingClientRect();
    const { k, tx, ty } = this.view;
    return { x: (clientX - rect.left - tx) / k, y: (clientY - rect.top - ty) / k };
  }

  fit(/** @type {boolean} */ animate) {
    const { bounds } = this.layout;
    const width = this.stage.clientWidth;
    const height = this.stage.clientHeight;
    if (!width || !height) return;
    if (bounds.w === 0 && bounds.h === 0) {
      this.setView({ k: 1, tx: width / 2, ty: height / 2 }, animate);
      return;
    }
    const padX = 48;
    const padTop = 64;
    const padBottom = 40;
    const k = Math.max(
      MIN_ZOOM,
      Math.min(MAX_FIT_ZOOM, (width - 2 * padX) / bounds.w, (height - padTop - padBottom) / bounds.h),
    );
    const tx = (width - bounds.w * k) / 2 - bounds.x * k;
    const ty = padTop + (height - padTop - padBottom - bounds.h * k) / 2 - bounds.y * k;
    this.autoFit = true;
    this.setView({ k, tx, ty }, animate);
  }

  // Frames a part of the diagram (a flow's components), animated.
  focusRect(/** @type {Rect | null} */ rect, /** @type {boolean} */ animate = true) {
    const width = this.stage.clientWidth;
    const height = this.stage.clientHeight;
    if (!width || !height || !rect || rect.w <= 0 || rect.h <= 0) return;
    const padX = 64;
    const padTop = 72;
    const padBottom = 64;
    const k = Math.max(MIN_ZOOM, Math.min(MAX_FIT_ZOOM, (width - 2 * padX) / rect.w, (height - padTop - padBottom) / rect.h));
    const tx = (width - rect.w * k) / 2 - rect.x * k;
    const ty = padTop + (height - padTop - padBottom - rect.h * k) / 2 - rect.y * k;
    this.autoFit = false;
    this.setView({ k, tx, ty }, animate);
  }

  zoomTo(/** @type {number} */ k, /** @type {Point | undefined} */ center) {
    const width = this.stage.clientWidth;
    const height = this.stage.clientHeight;
    const pivot = center ?? { x: width / 2, y: height / 2 };
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
    const ratio = next / this.view.k;
    this.autoFit = false;
    this.setView({
      k: next,
      tx: pivot.x - (pivot.x - this.view.tx) * ratio,
      ty: pivot.y - (pivot.y - this.view.ty) * ratio,
    });
  }

  zoomBy(/** @type {number} */ factor, /** @type {Point | undefined} */ center) {
    this.zoomTo(this.view.k * factor, center);
  }

  ensureVisible(/** @type {Selection | null} */ selection) {
    if (!selection || this.autoFit) return;
    const box = selection.type === 'node' ? this.layout.nodes.get(selection.id) : selection.type === 'group' ? this.layout.groups.get(selection.id) : null;
    if (!box) return;
    const a = this.toScreen(box);
    const b = this.toScreen({ x: box.x + box.w, y: box.y + box.h });
    const margin = 60;
    const width = this.stage.clientWidth;
    const height = this.stage.clientHeight;
    let dx = 0;
    let dy = 0;
    if (a.x < margin) dx = margin - a.x;
    else if (b.x > width - margin) dx = width - margin - b.x;
    if (a.y < margin) dy = margin - a.y;
    else if (b.y > height - margin) dy = height - margin - b.y;
    if (dx || dy) this.setView({ ...this.view, tx: this.view.tx + dx, ty: this.view.ty + dy }, true);
  }

  // ------------------------------------------------------------------ chrome

  renderChrome() {
    this.chrome.replaceChildren();
    this.chromeItems = [];
    const sel = this.editor.selection;
    if (this.readOnly || !sel || this.link) return;

    if (sel.type === 'node') this.nodeChrome(sel.id);
    else if (sel.type === 'edge') this.edgeChrome(sel.key);
    else if (sel.type === 'group') this.groupChrome(sel.id);
    else if (sel.type === 'note') this.noteChrome(sel.key);
    this.positionChrome();
  }

  // `fallbacks` are other [anchor, align] pairs to try, in order, when a
  // toolbar would not fit inside the canvas where it prefers to be.
  place(/** @type {HTMLElement} */ element, /** @type {() => Point} */ anchor, /** @type {ChromeAlign} */ align, /** @type {Array<[() => Point, ChromeAlign]>} */ fallbacks = []) {
    element.classList.add('sd-anchored');
    this.chrome.append(element);
    this.chromeItems.push({ element, options: [[anchor, align], ...fallbacks] });
  }

  positionChrome() {
    const stage = this.chromeItems.length ? this.stage.getBoundingClientRect() : null;
    const margin = 8;
    // A toolbar beside its anchor may slide vertically, one above or below it
    // may slide sideways; only the axis that keeps it off the anchor must fit.
    const fits = (/** @type {DOMRect} */ box, /** @type {ChromeAlign} */ align) => {
      return align === 'left' || align === 'right'
        ? box.left >= stage.left + margin && box.right <= stage.right - margin
        : box.top >= stage.top + margin && box.bottom <= stage.bottom - margin;
    };
    for (const { element, options } of this.chromeItems) {
      const apply = (/** @type {[() => Point, ChromeAlign]} */ [anchor, align]) => {
        for (const name of [...element.classList]) if (name.startsWith('sd-anchor-')) element.classList.remove(name);
        element.classList.add(`sd-anchor-${align}`);
        const point = this.toScreen(anchor());
        element.style.left = `${Math.round(point.x)}px`;
        element.style.top = `${Math.round(point.y)}px`;
        return point;
      };
      if (!element.classList.contains('sd-toolbar')) {
        apply(options[0]);
        continue;
      }
      const chosen = options.find((option) => fits((apply(option), element.getBoundingClientRect()), option[1])) ?? options[0];
      // Then push it fully inside the canvas.
      const point = apply(chosen);
      const box = element.getBoundingClientRect();
      const dx = Math.max(0, stage.left + margin - box.left) || Math.min(0, stage.right - margin - box.right);
      const dy = Math.max(0, stage.top + margin - box.top) || Math.min(0, stage.bottom - margin - box.bottom);
      if (dx || dy) {
        element.style.left = `${Math.round(point.x + dx)}px`;
        element.style.top = `${Math.round(point.y + dy)}px`;
      }
    }
    if (this.renameState) this.positionRename();
  }

  nodeChrome(/** @type {string} */ id) {
    const node = this.model.nodeById.get(id);
    const box = this.layout.nodes.get(id);
    if (!node || !box) return;
    const horizontal = this.layout.horizontal;

    for (const dir of ['out', 'in']) {
      const handle = el(
        'button',
        {
          type: 'button',
          class: 'sd-handle',
          title: dir === 'out' ? 'Add next (Tab). Drag to link.' : 'Add previous (⇧Tab). Drag to link.',
          'aria-label': dir === 'out' ? 'Add next component' : 'Add previous component',
        },
        icon('plus', 14),
      );
      handle.addEventListener('pointerdown', (event) => this.onHandleDown(event, id, dir));
      const anchor = () => {
        const b = this.layout.nodes.get(id) ?? box;
        if (horizontal) return dir === 'out' ? { x: b.x + b.w, y: b.y + b.h / 2 } : { x: b.x, y: b.y + b.h / 2 };
        return dir === 'out' ? { x: b.x + b.w / 2, y: b.y + b.h } : { x: b.x + b.w / 2, y: b.y };
      };
      const align = horizontal ? (dir === 'out' ? 'right' : 'left') : dir === 'out' ? 'bottom' : 'top';
      this.place(handle, anchor, align);
    }

    const groups = this.model.groups;
    const groupSelect = groups.length
      ? el(
          'select',
          {
            class: 'sd-select',
            title: 'Move to group',
            'aria-label': 'Move to group',
            onchange: (/** @type {Event & { target: HTMLSelectElement }} */ event) => {
              const value = event.target.value || null;
              this.editor.commit(edits.moveNodeToGroup(this.editor.text, id, value));
              this.focus();
            },
          },
          el('option', { value: '', text: 'No group', selected: node.group === null }),
          groups.map((g) => el('option', { value: g.id, text: g.label, selected: node.group === g.id })),
        )
      : null;

    const toolbar = el(
      'div',
      { class: 'sd-floating sd-toolbar' },
      button({ iconName: node.kind, text: KINDS[node.kind].label, label: 'Change type (T)', onClick: () => this.openKindPicker(id) }),
      el('span', { class: 'sd-sep' }),
      button({ iconName: 'pencil', label: 'Rename (Enter)', onClick: () => this.startRename({ type: 'node', id }) }),
      button({ iconName: 'details', label: 'Details: instances and properties (D)', onClick: () => this.openDetails(id) }),
      button({ iconName: 'note', label: 'Add a note (N)', onClick: () => this.openNoteEditor({ target: id }) }),
      button({ iconName: 'link', label: 'Link to… (L)', onClick: () => this.startLink(id, 'out') }),
      groupSelect,
      button({ iconName: 'trash', label: 'Delete (⌫)', onClick: () => this.deleteSelection(), className: 'sd-danger' }),
    );
    // Above the node when flowing right; beside it when flowing down, where
    // the space above belongs to the upstream component. Never over the node
    // itself, so a double click still reaches it.
    const at = (/** @type {number} */ fx, /** @type {number} */ fy) => () => {
      const b = this.layout.nodes.get(id) ?? box;
      return { x: b.x + b.w * fx, y: b.y + b.h * fy };
    };
    if (horizontal) {
      this.place(toolbar, at(0.5, 0), 'top', [[at(0.5, 1), 'bottom']]);
    } else {
      this.place(toolbar, at(1, 0.5), 'right', [
        [at(0, 0.5), 'left'],
        [at(0.5, 0), 'top-far'],
        [at(0.5, 1), 'bottom-far'],
      ]);
    }
  }

  edgeChrome(/** @type {string} */ key) {
    const edge = this.model.edgeByKey.get(key);
    const geometry = this.layout.edges.get(key);
    if (!edge || !geometry?.points) return;

    const labelInput = el('input', {
      class: 'sd-input sd-edge-label-input',
      placeholder: 'label',
      value: edge.label,
      size: Math.max(8, edge.label.length + 1),
      'aria-label': 'Link label',
    });
    const commitLabel = () => {
      if (labelInput.value.trim() !== edge.label) {
        this.editor.commit(edits.setEdgeLabel(this.editor.text, key, labelInput.value));
      }
    };
    labelInput.addEventListener('keydown', (event) => {
      if (isComposing(event) || event.metaKey || event.ctrlKey) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        commitLabel();
        this.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        labelInput.value = edge.label;
        this.focus();
      }
      event.stopPropagation();
    });
    labelInput.addEventListener('blur', commitLabel);
    labelInput.addEventListener('input', () => {
      labelInput.size = Math.max(8, labelInput.value.length + 1);
    });

    const propsValue = edge.props.join(', ');
    const propsInput = el('input', {
      class: 'sd-input sd-edge-props-input',
      placeholder: 'details',
      title: 'Details, comma separated (e.g. 10k QPS, p99 < 50ms)',
      value: propsValue,
      size: Math.max(7, propsValue.length + 1),
      'aria-label': 'Link details',
    });
    const commitProps = () => {
      if (propsInput.value.trim() !== propsValue) {
        this.editor.commit(edits.setEdgeProps(this.editor.text, key, propsInput.value));
      }
    };
    propsInput.addEventListener('keydown', (event) => {
      if (isComposing(event) || event.metaKey || event.ctrlKey) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        commitProps();
        this.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        propsInput.value = propsValue;
        this.focus();
      }
      event.stopPropagation();
    });
    propsInput.addEventListener('blur', commitProps);
    propsInput.addEventListener('input', () => {
      propsInput.size = Math.max(7, propsInput.value.length + 1);
    });

    const setOp = (/** @type {LinkOp} */ op) => {
      if (op !== edge.op) this.editor.commit(edits.setEdgeOp(this.editor.text, key, op));
    };
    const toolbar = el(
      'div',
      { class: 'sd-floating sd-toolbar' },
      el(
        'div',
        { class: 'sd-segmented', role: 'group', 'aria-label': 'Link type' },
        OP_LIST.map((op) => button({ text: OP_TEXT[op], label: `${OPS[op].label}: ${OPS[op].hint} (E cycles)`, pressed: edge.op === op, onClick: () => setOp(op) })),
      ),
      labelInput,
      propsInput,
      button({ iconName: 'swap', label: 'Reverse (R)', onClick: () => this.editor.commit(edits.reverseEdge(this.editor.text, key)) }),
      button({ iconName: 'trash', label: 'Delete (⌫)', onClick: () => this.deleteSelection(), className: 'sd-danger' }),
    );
    this.edgeLabelInput = labelInput;
    this.edgePropsInput = propsInput;
    const anchor = () => {
      const g = this.layout.edges.get(key) ?? geometry;
      if (g.label) return { x: g.label.x + g.label.w / 2, y: g.label.y };
      const points = g.points;
      /**
       * The longest segment so far and its midpoint (none before the first one).
       * @type {{ length: number, x?: number, y?: number }}
       */
      let best = { length: -1 };
      for (let i = 1; i < points.length; i += 1) {
        const length = Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y);
        if (length > best.length) best = { length, x: (points[i].x + points[i - 1].x) / 2, y: (points[i].y + points[i - 1].y) / 2 };
      }
      return best;
    };
    const below = () => {
      const g = this.layout.edges.get(key) ?? geometry;
      return g.label ? { x: g.label.x + g.label.w / 2, y: g.label.y + g.label.h } : anchor();
    };
    this.place(toolbar, anchor, 'top', [[below, 'bottom']]);
  }

  groupChrome(/** @type {string} */ id) {
    const group = this.model.groupById.get(id);
    const box = this.layout.groups.get(id);
    if (!group || !box) return;
    const toolbar = el(
      'div',
      { class: 'sd-floating sd-toolbar' },
      button({ iconName: 'plus', text: 'Add inside', label: 'Add a component to this group', onClick: () => this.openAddForm({ group: id }) }),
      button({ iconName: 'pencil', label: 'Rename (Enter)', onClick: () => this.startRename({ type: 'group', id }) }),
      button({ iconName: 'ungroup', label: 'Ungroup, keeping contents (⌫)', onClick: () => this.deleteSelection(), className: 'sd-danger' }),
    );
    const anchor = () => {
      const b = this.layout.groups.get(id) ?? box;
      return { x: b.x, y: b.y };
    };
    this.place(toolbar, anchor, 'top-start');
  }

  noteChrome(/** @type {string} */ key) {
    const note = this.model.noteByKey.get(key);
    if (!note || !this.noteBox(key)) return;
    const toolbar = el(
      'div',
      { class: 'sd-floating sd-toolbar' },
      button({ iconName: 'pencil', text: 'Edit note', label: 'Edit note (Enter)', onClick: () => this.openNoteEditor({ key }) }),
      button({ iconName: 'trash', label: 'Delete note (⌫)', onClick: () => this.deleteSelection(), className: 'sd-danger' }),
    );
    const anchor = (/** @type {number} */ fy) => () => {
      const b = this.noteBox(key);
      return b ? { x: b.x + b.w / 2, y: b.y + b.h * fy } : { x: 0, y: 0 };
    };
    this.place(toolbar, anchor(0), 'top', [[anchor(1), 'bottom']]);
  }

  noteBox(/** @type {string} */ key) {
    for (const block of this.layout.notes?.values() ?? []) {
      const item = block.items.find((i) => i.key === key);
      if (item) return item;
    }
    return null;
  }

  // ------------------------------------------------------------------ rename

  startRename(/** @type {Selection} */ selection) {
    if (this.readOnly) return;
    if (selection.type === 'note') {
      this.openNoteEditor({ key: selection.key });
      return;
    }
    const isNode = selection.type === 'node';
    const item = isNode ? this.model.nodeById.get(selection.id) : this.model.groupById.get(selection.id);
    if (!item) return;
    this.closePopover();
    const input = el('input', { class: 'sd-rename', value: item.label, 'aria-label': 'Name' });
    let done = false;
    const finish = (/** @type {boolean} */ save) => {
      if (done) return;
      done = true;
      this.renameState = null;
      input.remove();
      const value = input.value.trim();
      if (save && value && value !== item.label) {
        const edit = isNode ? edits.setNodeLabel : edits.setGroupLabel;
        this.editor.commit(edit(this.editor.text, selection.id, value));
      }
      this.focus();
    };
    this.renameState = { selection, input, finish };
    input.addEventListener('keydown', (event) => {
      if (isComposing(event) || event.metaKey || event.ctrlKey) return;
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    this.stage.append(input);
    this.positionRename();
    input.focus();
    input.select();
  }

  // Ends a rename without saving it (another document was opened).
  cancelRename() {
    this.renameState?.finish(false);
  }

  positionRename() {
    const { selection, input } = this.renameState;
    const box = selection.type === 'node' ? this.layout.nodes.get(selection.id) : this.layout.groups.get(selection.id);
    if (!box) return;
    const { k } = this.view;
    const origin = selection.type === 'node' ? { x: box.x + 52, y: box.y + 10 } : { x: box.x + 8, y: box.y + 3 };
    const width = selection.type === 'node' ? box.w - 58 : Math.max(160, box.w * 0.6);
    const point = this.toScreen(origin);
    Object.assign(input.style, {
      left: `${point.x}px`,
      top: `${point.y}px`,
      width: `${width * k}px`,
      height: `${(selection.type === 'node' ? 22 : 20) * k}px`,
      fontSize: `${(selection.type === 'node' ? 13 : 11.5) * k}px`,
    });
  }

  // ---------------------------------------------------------------- popovers

  openPopover(/** @type {HTMLElement} */ content, /** @type {Point} */ screenPoint, /** @type {{ className?: string, onClose?: () => void, anchor?: HTMLElement | null }} */ { className = '', onClose, anchor = null } = {}) {
    this.closePopover();
    const popover = el('div', { class: `sd-floating sd-popover ${className}`.trim(), role: 'dialog' }, content);
    popover.addEventListener('keydown', (event) => {
      if (isComposing(event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closePopover();
        this.focus();
      }
    });
    this.popoverHost.append(popover);
    // The button that opened it: pressing it again closes it (see onPointerDown).
    this.popover = { element: popover, onClose, anchor };
    const width = this.stage.clientWidth;
    const height = this.stage.clientHeight;
    const pw = popover.offsetWidth;
    const ph = popover.offsetHeight;
    // Never past the top or the left edge: a popover taller than the canvas scrolls.
    const x = Math.max(8, Math.min(screenPoint.x, width - pw - 8));
    const y = Math.max(8, Math.min(screenPoint.y, height - ph - 8));
    popover.style.left = `${x}px`;
    popover.style.top = `${y}px`;
    return popover;
  }

  closePopover() {
    if (!this.popover) return;
    const { element, onClose } = this.popover;
    this.popover = null;
    element.remove();
    onClose?.();
  }

  // Shared form for "add a component", optionally linked to an existing one.
  //   link:  { id, dir: 'out' | 'in' }   new node goes after / before `id`
  //   group: group id to add into (defaults to the linked node's group)
  //   kind:  preselected type ('group' allowed when not linking)
  openAddForm(/** @type {AddFormOptions} */ { link = null, group, kind: presetKind, at } = {}) {
    if (this.readOnly) return;
    const model = this.model;
    const source = link ? model.nodeById.get(link.id) : null;
    let kind = presetKind ?? this.editor.lastKind ?? 'service';
    if (link && kind === 'group') kind = 'service';
    let opTouched = false;
    const opFor = (/** @type {string} */ k) => {
      if (!source || k === 'group') return '->';
      return link.dir === 'out' ? defaultLinkOp(source.kind, k) : defaultLinkOp(k, source.kind);
    };

    const nameInput = el('input', { class: 'sd-input', placeholder: 'Name', 'aria-label': 'Name', autocomplete: 'off' });
    const linkLabel = el('input', { class: 'sd-input', placeholder: 'Link label (optional)', 'aria-label': 'Link label' });
    /**
     * The link type radios by operator, made only when the new component is linked.
     * @type {Partial<Record<LinkOp, HTMLInputElement>>}
     */
    const opInputs = {};
    const opRow = link
      ? el(
          'div',
          { class: 'sd-form-row' },
          el(
            'div',
            { class: 'sd-segmented sd-radio-seg', role: 'radiogroup', 'aria-label': 'Link type' },
            OP_LIST.map((op) => {
              opInputs[op] = el('input', {
                type: 'radio',
                name: 'sd-op',
                value: op,
                checked: op === opFor(kind),
                onchange: () => {
                  opTouched = true;
                },
              });
              return el('label', { title: OPS[op].hint }, opInputs[op], el('span', { text: OP_TEXT[op] }));
            }),
          ),
          linkLabel,
        )
      : null;

    const defaultGroup = group !== undefined ? group : source?.group ?? null;
    const groupSelect = model.groups.length
      ? el(
          'select',
          { class: 'sd-select', 'aria-label': 'Group' },
          el('option', { value: '', text: 'No group' }),
          model.groups.map((g) => el('option', { value: g.id, text: `in ${g.label}`, selected: g.id === defaultGroup })),
        )
      : null;

    const grid = kindGrid({
      name: 'sd-kind',
      value: kind,
      includeGroup: !link,
      onChange: (value) => {
        kind = value;
        if (link && !opTouched) {
          const op = opFor(kind);
          opInputs[op].checked = true;
        }
        nameInput.placeholder = kind === 'group' ? 'Group name' : 'Name';
      },
    });

    const direction = link ? (link.dir === 'out' ? `after ${source.label}` : `before ${source.label}`) : null;
    const form = el(
      'form',
      { class: 'sd-form' },
      el('div', { class: 'sd-form-title' }, el('span', { text: 'Add' }), direction ? el('span', { class: 'sd-muted', text: direction }) : null),
      nameInput,
      grid,
      opRow,
      el(
        'div',
        { class: 'sd-form-row sd-form-actions' },
        groupSelect,
        el('span', { class: 'sd-muted sd-hint', text: '↵ add · esc cancel' }),
        el('button', { type: 'submit', class: 'sd-btn sd-primary', text: 'Add' }),
      ),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = nameInput.value.trim();
      const groupId = groupSelect ? groupSelect.value || null : null;
      /** @type {EditResult} */
      let result;
      if (kind === 'group') {
        result = edits.addGroup(this.editor.text, { label: name, parent: groupId });
      } else {
        result = edits.addNode(this.editor.text, { kind, label: name, group: groupId });
        if (link) {
          const id = result.select.id;
          const [from, to] = link.dir === 'out' ? [link.id, id] : [id, link.id];
          const op = OP_LIST.find((candidate) => opInputs[candidate].checked) ?? '->';
          const linked = edits.addEdge(result.text, { from, to, op, label: linkLabel.value.trim() });
          result = { text: linked.text, select: result.select };
        }
        this.editor.lastKind = kind;
      }
      this.closePopover();
      this.editor.commit(result);
      this.focus();
    });

    let point = at;
    if (!point && source) {
      const box = this.layout.nodes.get(source.id);
      const horizontal = this.layout.horizontal;
      const anchor = horizontal
        ? { x: link.dir === 'out' ? box.x + box.w + 24 : box.x - 24, y: box.y }
        : { x: box.x, y: link.dir === 'out' ? box.y + box.h + 24 : box.y - 24 };
      point = this.toScreen(anchor);
      if (horizontal && link.dir === 'in') point.x -= 340;
      if (!horizontal && link.dir === 'in') point.y -= 360;
    }
    if (!point && group) {
      const box = this.layout.groups.get(group);
      if (box) point = this.toScreen({ x: box.x, y: box.y + box.h + 8 });
    }
    point ??= { x: this.stage.clientWidth / 2 - 170, y: 70 };

    this.openPopover(form, point, { className: 'sd-add-popover' });
    nameInput.focus();
  }

  openKindPicker(/** @type {string} */ id) {
    const node = this.model.nodeById.get(id);
    const box = this.layout.nodes.get(id);
    if (!node || !box || this.readOnly) return;
    const grid = kindGrid({
      name: 'sd-kind-change',
      value: node.kind,
      includeGroup: false,
      onChange: (kind) => this.editor.commit(edits.setNodeKind(this.editor.text, id, kind)),
    });
    // Close after the click has finished: removing the radio during its own
    // click handler would cancel the change event that applies the new type.
    grid.addEventListener('click', (event) => {
      // Arrow keys move between the radios with a click of detail 0: only a
      // real click closes the picker; from the keyboard, Enter or Escape does.
      if (event.target instanceof HTMLInputElement && event.detail > 0) {
        window.setTimeout(() => {
          this.closePopover();
          this.focus();
        });
      }
    });
    grid.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.closePopover();
        this.focus();
      }
    });
    const point = this.toScreen({ x: box.x, y: box.y + box.h + 10 });
    const popover = this.openPopover(el('div', { class: 'sd-form' }, el('div', { class: 'sd-form-title', text: 'Type' }), grid), point);
    /** @type {HTMLInputElement | null} */ (popover.querySelector('input:checked'))?.focus();
  }

  // Instances ("x3") and properties ("[Postgres, sharded by user_id]").
  openDetails(/** @type {string} */ id) {
    const node = this.model.nodeById.get(id);
    const box = this.layout.nodes.get(id);
    if (!node || !box || this.readOnly) return;
    const countInput = el('input', {
      class: 'sd-input sd-count-input',
      value: node.count ? String(node.count) : '',
      placeholder: '1',
      'aria-label': 'Instances',
      autocomplete: 'off',
    });
    const propsInput = el('input', {
      class: 'sd-input',
      value: node.props.join(', '),
      placeholder: 'e.g. Postgres, sharded by user_id',
      'aria-label': 'Properties',
      autocomplete: 'off',
    });
    const form = el(
      'form',
      { class: 'sd-form sd-details-form' },
      el('div', { class: 'sd-form-title' }, el('span', { text: 'Details' }), el('span', { class: 'sd-muted', text: node.label })),
      el(
        'label',
        { class: 'sd-field' },
        el('span', { text: 'Instances' }),
        el('span', { class: 'sd-field-row' }, countInput, el('span', { class: 'sd-muted sd-hint', text: 'a number, or N for "many". Drawn as a stack.' })),
      ),
      el('label', { class: 'sd-field' }, el('span', { text: 'Properties' }), propsInput, el('span', { class: 'sd-muted sd-hint', text: 'comma separated: technology, scaling, guarantees' })),
      el('div', { class: 'sd-form-row sd-form-actions' }, el('span', { class: 'sd-muted sd-hint', text: '↵ save · esc cancel' }), el('button', { type: 'submit', class: 'sd-btn sd-primary', text: 'Save' })),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      let result = edits.setNodeCount(this.editor.text, id, countInput.value);
      result = edits.setNodeProps(result.text, id, propsInput.value);
      this.closePopover();
      this.editor.commit(result);
      this.focus();
    });
    const point = this.toScreen({ x: box.x, y: box.y + box.h + 10 });
    this.openPopover(form, point, { className: 'sd-details-popover' });
    propsInput.focus();
  }

  // `target` adds a note to that component; `key` edits an existing note.
  openNoteEditor(/** @type {{ target?: string, key?: string }} */ { target, key }) {
    if (this.readOnly) return;
    const note = key ? this.model.noteByKey.get(key) : null;
    const owner = note?.target ?? target;
    const node = this.model.nodeById.get(owner);
    if (!node) return;
    const input = el('textarea', {
      class: 'sd-input sd-note-input',
      value: note?.text ?? '',
      rows: 3,
      placeholder: 'Why it is built this way, a trade-off, a number…',
      'aria-label': 'Note',
    });
    const save = () => {
      const value = input.value.replace(/\s*\n\s*/g, ' ').trim();
      const result = note ? edits.setNoteText(this.editor.text, key, value) : edits.addNote(this.editor.text, owner, value);
      this.closePopover();
      if (value || note) this.editor.commit(result);
      this.focus();
    };
    input.addEventListener('keydown', (event) => {
      if (isComposing(event)) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        save();
      }
    });
    const form = el(
      'form',
      { class: 'sd-form sd-note-form' },
      el('div', { class: 'sd-form-title' }, el('span', { text: note ? 'Edit note' : 'Add note' }), el('span', { class: 'sd-muted', text: `on ${node.label}` })),
      input,
      el(
        'div',
        { class: 'sd-form-row sd-form-actions' },
        el('span', { class: 'sd-muted sd-hint', text: note ? '↵ save · empty deletes · esc cancel' : '↵ add · esc cancel' }),
        el('button', { type: 'submit', class: 'sd-btn sd-primary', text: note ? 'Save' : 'Add' }),
      ),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      save();
    });
    const anchorBox = (key && this.noteBox(key)) || this.layout.nodes.get(owner);
    const point = this.toScreen({ x: anchorBox.x, y: anchorBox.y + anchorBox.h + 10 });
    this.openPopover(form, point, { className: 'sd-note-popover' });
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  toggleExport(/** @type {HTMLElement} */ anchor) {
    if (this.popover?.element.classList.contains('sd-export')) {
      this.closePopover();
      return;
    }
    const item = (/** @type {string} */ iconName, /** @type {string} */ title, /** @type {string} */ detail, /** @type {() => Promise<void>} */ action) =>
      el(
        'button',
        {
          type: 'button',
          class: 'sd-menu-item',
          onclick: () => {
            this.closePopover();
            // Each export reports its own failure.
            void action();
          },
        },
        icon(iconName, 16),
        el('span', { class: 'sd-menu-text' }, el('span', { text: title }), el('span', { class: 'sd-muted', text: detail })),
      );
    const viewing = this.editor.readOnly ? this.editor.snapshot(this.editor.version)?.name : null;
    const documentItems =
      this.editor.host.exportsDocument === false
        ? []
        : [el('span', { class: 'sd-menu-sep' }), item('doc', 'Diagram note (.md)', 'text, notes and every saved version', () => this.editor.exportDocument())];
    const content = el(
      'div',
      { class: 'sd-form sd-menu' },
      el('div', { class: 'sd-form-title' }, el('span', { text: 'Export' }), el('span', { class: 'sd-muted', text: viewing ? `version "${viewing}"` : 'what is on screen' })),
      item('image', 'PNG image', 'for docs, slides and chats (2x)', () => this.editor.exportImage('png')),
      item('image', 'SVG image', 'sharp at any size, editable', () => this.editor.exportImage('svg')),
      ...documentItems,
    );
    const stage = this.stage.getBoundingClientRect();
    const box = anchor.getBoundingClientRect();
    this.openPopover(content, { x: box.left - stage.left, y: box.bottom - stage.top + 6 }, { className: 'sd-export', anchor });
  }

  renderFlowbar() {
    const flows = this.model.flows;
    this.flowbar.hidden = flows.length === 0;
    if (flows.length === 0) return;
    const active = this.editor.activeFlow;
    this.flowbar.replaceChildren(
      el('span', { class: 'sd-flowbar-title' }, icon('flow', 14), el('span', { text: 'Flows' })),
      ...flows.map((flow, index) =>
        el(
          'button',
          {
            type: 'button',
            class: 'sd-btn sd-flow-chip',
            title: `${flow.label}: ${walkable(flow).length} step${walkable(flow).length === 1 ? '' : 's'} (W walks through flows)`,
            'aria-pressed': String(active === flow.id),
            onclick: () => this.editor.setFlow(active === flow.id ? null : flow.id),
          },
          el('span', { class: 'sd-flow-index', text: String(index + 1) }),
          el('span', { text: flow.label }),
        ),
      ),
    );
  }

  toggleHelp(/** @type {HTMLElement | null} */ anchor = null) {
    if (this.popover?.element.classList.contains('sd-help')) {
      this.closePopover();
      return;
    }
    const rows = shortcuts().map(([keys, what]) => el('div', { class: 'sd-help-row' }, el('kbd', { text: keys }), el('span', { text: what })));
    const content = el(
      'div',
      { class: 'sd-form' },
      el('div', { class: 'sd-form-title', text: 'Keyboard' }),
      rows,
      el('p', { class: 'sd-muted sd-help-foot' }, `Wheel or drag pans; ${modName()} + wheel or a pinch zooms. Clicking a component highlights its line in the source, and moving the caret selects it on the canvas.`),
    );
    this.openPopover(content, { x: 12, y: 56 }, { className: 'sd-help', anchor });
  }

  // -------------------------------------------------------------------- links

  startLink(/** @type {string} */ anchor, /** @type {LinkDirection} */ dir, /** @type {boolean} */ viaDrag = false) {
    if (this.readOnly) return;
    this.closePopover();
    this.link = { anchor, dir, target: null, viaDrag, pointer: null };
    this.stage.classList.add('is-linking');
    this.renderChrome();
    this.updateLinkPreview();
  }

  cancelLink() {
    this.link = null;
    this.stage.classList.remove('is-linking');
    this.renderer.setLinkTarget(null);
    this.renderer.showLinkPreview(null);
    this.renderChrome();
  }

  setLinkTarget(/** @type {string | null} */ id) {
    if (!this.link) return;
    this.link.target = id && id !== this.link.anchor ? id : null;
    this.renderer.setLinkTarget(this.link.target);
    this.updateLinkPreview();
  }

  updateLinkPreview() {
    const { link } = this;
    if (!link) return;
    const box = this.layout.nodes.get(link.anchor);
    if (!box) return;
    const from = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    let to = link.pointer;
    const target = link.target && this.layout.nodes.get(link.target);
    if (target) to = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
    this.renderer.showLinkPreview(from, to);
  }

  finishLink() {
    const { link } = this;
    if (!link?.target) {
      this.cancelLink();
      return;
    }
    const a = this.model.nodeById.get(link.anchor);
    const b = this.model.nodeById.get(link.target);
    const [from, to] = link.dir === 'out' ? [a, b] : [b, a];
    this.cancelLink();
    this.editor.commit(edits.addEdge(this.editor.text, { from: from.id, to: to.id, op: defaultLinkOp(from.kind, to.kind) }));
    this.focus();
  }

  onHandleDown(/** @type {PointerEvent} */ event, /** @type {string} */ id, /** @type {LinkDirection} */ dir) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    let dragging = false;

    // Tracked on window, not the handle: entering link mode re-renders the
    // chrome, which removes the handle (and any pointer capture it held).
    const win = viewOf(this.stage);
    const move = (/** @type {PointerEvent} */ e) => {
      if (e.pointerId !== pointerId) return;
      if (!dragging && Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_THRESHOLD + 2) {
        dragging = true;
        this.startLink(id, dir, true);
      }
      if (dragging && this.link) {
        this.link.pointer = this.toWorld(e.clientX, e.clientY);
        /** @type {Selection | null} */
        const hit = this.renderer.hit(this.stage.ownerDocument.elementFromPoint(e.clientX, e.clientY));
        this.setLinkTarget(hit?.type === 'node' ? hit.id : null);
        this.updateLinkPreview();
      }
    };
    const up = (/** @type {PointerEvent} */ e) => {
      if (e.pointerId !== pointerId) return;
      win.removeEventListener('pointermove', move);
      win.removeEventListener('pointerup', up);
      win.removeEventListener('pointercancel', up);
      if (!dragging) this.openAddForm({ link: { id, dir } });
      else if (e.type === 'pointerup') this.finishLink();
      else this.cancelLink();
    };
    win.addEventListener('pointermove', move);
    win.addEventListener('pointerup', up);
    win.addEventListener('pointercancel', up);
  }

  // ----------------------------------------------------------------- actions

  focus() {
    this.stage.focus({ preventScroll: true });
  }

  deleteSelection() {
    const sel = this.editor.selection;
    if (!sel || this.readOnly) return;
    const text = this.editor.text;
    if (sel.type === 'node') this.editor.commit(edits.removeNode(text, sel.id));
    else if (sel.type === 'edge') this.editor.commit(edits.removeEdge(text, sel.key));
    else if (sel.type === 'group') this.editor.commit(edits.ungroup(text, sel.id));
    else if (sel.type === 'note') this.editor.commit(edits.removeNote(text, sel.key));
    this.focus();
  }

  toggleDirection() {
    const next = this.model.direction === 'down' ? 'right' : 'down';
    this.editor.commit({ ...edits.setDirection(this.editor.text, next), select: this.editor.selection }, { refit: true });
  }

  navigate(/** @type {'ArrowRight' | 'ArrowLeft' | 'ArrowDown' | 'ArrowUp'} */ key) {
    const nodes = [...this.layout.nodes.values()].filter((n) => this.model.nodeById.has(n.id));
    if (nodes.length === 0) return;
    /** @type {Selection | null} */
    const sel = this.link ? { type: 'node', id: this.link.target ?? this.link.anchor } : this.editor.selection;
    const current = sel?.type === 'node' ? this.layout.nodes.get(sel.id) : null;
    if (!current) {
      const first = this.model.nodes[0];
      if (this.link) this.setLinkTarget(first.id);
      else this.editor.select({ type: 'node', id: first.id });
      return;
    }
    const [dx, dy] = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[key];
    const cx = current.x + current.w / 2;
    const cy = current.y + current.h / 2;
    /** @type {{ id: string, score: number } | null} */
    let best = null;
    for (const node of nodes) {
      if (node.id === current.id) continue;
      const ox = node.x + node.w / 2 - cx;
      const oy = node.y + node.h / 2 - cy;
      const along = ox * dx + oy * dy;
      if (along <= 1) continue;
      const across = Math.abs(ox * dy - oy * dx);
      const score = along + across * 2;
      if (!best || score < best.score) best = { id: node.id, score };
    }
    if (!best) return;
    if (this.link) this.setLinkTarget(best.id);
    else this.editor.select({ type: 'node', id: best.id });
  }

  // ------------------------------------------------------------------ events

  onPointerDown(/** @type {StageEvent<PointerEvent>} */ event) {
    const popover = this.popover;
    if (popover && !popover.element.contains(event.target) && !popover.anchor?.contains(event.target)) this.closePopover();
    if (event.target.closest?.('.sd-floating, .sd-handle, .sd-rename, .sd-empty-add')) return;
    if (event.button !== 0 && event.button !== 1) return;
    if (event.pointerType === 'touch') {
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pointers.size === 2) {
        this.startPinch();
        return;
      }
    }
    // What was pressed, before focusing ends a rename and redraws the canvas.
    /** @type {Selection | null} */
    const hit = this.renderer.hit(event.target);
    this.focus();
    this.drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      view: { ...this.view },
      moved: false,
      hit,
    };
  }

  // Two fingers: zoom around their midpoint, pan as it moves. A pinch never
  // selects anything, and the canvas waits for both fingers to lift.
  startPinch() {
    const [a, b] = [...this.pointers.values()];
    const rect = this.stage.getBoundingClientRect();
    this.endDrag();
    this.pinch = {
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      mid: { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top },
      view: { ...this.view },
    };
  }

  movePinch() {
    const [a, b] = [...this.pointers.values()];
    const rect = this.stage.getBoundingClientRect();
    const { distance, mid, view } = this.pinch;
    const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (view.k * Math.hypot(a.x - b.x, a.y - b.y)) / distance));
    const world = { x: (mid.x - view.tx) / view.k, y: (mid.y - view.ty) / view.k };
    const now = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
    this.autoFit = false;
    this.setView({ k, tx: now.x - world.x * k, ty: now.y - world.y * k });
  }

  liftPointer(/** @type {PointerEvent} */ event) {
    if (!this.pointers.delete(event.pointerId)) return;
    if (this.pinch && this.pointers.size < 2) {
      this.pinch = null;
      this.endDrag();
    }
  }

  onPointerMove(/** @type {PointerEvent} */ event) {
    if (this.pointers.has(event.pointerId)) {
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.pinch && this.pointers.size >= 2) {
        this.movePinch();
        return;
      }
    }
    if (this.link && !this.link.viaDrag) {
      this.link.pointer = this.toWorld(event.clientX, event.clientY);
      /** @type {Selection | null} */
      const hit = this.renderer.hit(event.target);
      this.setLinkTarget(hit?.type === 'node' ? hit.id : null);
    }
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!drag.moved) {
      drag.moved = true;
      this.stage.setPointerCapture(event.pointerId);
      this.stage.classList.add('is-panning');
    }
    this.autoFit = false;
    this.setView({ k: drag.view.k, tx: drag.view.tx + dx, ty: drag.view.ty + dy });
  }

  onPointerUp(/** @type {PointerEvent} */ event) {
    this.liftPointer(event);
    const drag = this.drag;
    this.endDrag();
    if (!drag || drag.id !== event.pointerId || drag.moved) return;
    const hit = drag.hit;
    if (this.link) {
      if (hit?.type === 'node' && hit.id !== this.link.anchor) {
        this.setLinkTarget(hit.id);
        this.finishLink();
      } else {
        this.cancelLink();
      }
      return;
    }
    this.editor.select(hit);
  }

  endDrag() {
    this.drag = null;
    this.stage.classList.remove('is-panning');
  }

  onDoubleClick(/** @type {StageEvent<MouseEvent>} */ event) {
    if (this.readOnly || event.target.closest?.('.sd-floating, .sd-handle, .sd-rename')) return;
    /** @type {Selection | null} */
    const hit = this.renderer.hit(event.target);
    if (hit?.type === 'node' || hit?.type === 'group' || hit?.type === 'note') {
      this.editor.select(hit);
      this.startRename(hit);
    } else if (hit?.type === 'edge') {
      this.editor.select(hit);
      viewOf(this.stage).requestAnimationFrame(() => this.edgeLabelInput?.focus());
    } else if (!hit) {
      const rect = this.stage.getBoundingClientRect();
      this.openAddForm({ at: { x: event.clientX - rect.left, y: event.clientY - rect.top } });
    }
  }

  onWheel(/** @type {StageEvent<WheelEvent>} */ event) {
    // A popover that scrolls keeps its wheel.
    if (event.target.closest?.('.sd-popover')) return;
    event.preventDefault();
    const rect = this.stage.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025));
      this.zoomBy(factor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    } else {
      const scale = event.deltaMode === 1 ? 16 : 1;
      this.autoFit = false;
      this.setView({ ...this.view, tx: this.view.tx - event.deltaX * scale, ty: this.view.ty - event.deltaY * scale });
    }
  }

  onKeyDown(/** @type {KeyboardEvent} */ event) {
    if (isComposing(event) || isTypingTarget(event.target)) return;
    const target = event.target instanceof Element && event.target !== this.stage ? event.target : null;
    // Forms and menus keep their keys (Escape still closes them), and a focused
    // button is pressed by Enter and Space, not taken as a canvas shortcut.
    if (target?.closest('.sd-popover') && event.key !== 'Escape') return;
    if (target?.closest('button, a, select') && (event.key === 'Enter' || event.key === ' ')) return;
    const mod = event.metaKey || event.ctrlKey;
    const sel = this.editor.selection;
    const editable = !this.readOnly;

    if (event.key === 'Escape') {
      if (this.popover) this.closePopover();
      else if (this.link) this.cancelLink();
      else if (sel) this.editor.select(null);
      else if (this.editor.activeFlow) this.editor.setFlow(null);
      event.preventDefault();
      return;
    }
    if (mod) return;

    if (this.link) {
      if (event.key.startsWith('Arrow')) this.navigate(event.key);
      else if (event.key === 'Enter') this.finishLink();
      else return;
      event.preventDefault();
      return;
    }

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    let handled = true;
    switch (key) {
      case 'Tab':
        if (editable && sel?.type === 'node') this.openAddForm({ link: { id: sel.id, dir: event.shiftKey ? 'in' : 'out' } });
        else handled = false;
        break;
      case 'Enter':
      case 'F2':
        if (!editable || !sel) handled = false;
        else if (sel.type === 'edge') this.edgeLabelInput?.focus();
        else this.startRename(sel);
        break;
      case 'Delete':
      case 'Backspace':
        if (editable && sel) this.deleteSelection();
        else handled = false;
        break;
      case 'ArrowUp':
      case 'ArrowDown':
      case 'ArrowLeft':
      case 'ArrowRight':
        this.navigate(key);
        break;
      case 'l':
        if (editable && sel?.type === 'node') this.startLink(sel.id, 'out');
        break;
      case 't':
        if (editable && sel?.type === 'node') this.openKindPicker(sel.id);
        break;
      case 'e':
        if (editable && sel?.type === 'edge') {
          const edge = this.model.edgeByKey.get(sel.key);
          const next = OP_LIST[(OP_LIST.indexOf(edge.op) + 1) % OP_LIST.length];
          this.editor.commit(edits.setEdgeOp(this.editor.text, sel.key, next));
        }
        break;
      case 'd':
        if (editable && sel?.type === 'node') this.openDetails(sel.id);
        else if (editable && sel?.type === 'edge') this.edgePropsInput?.focus();
        else handled = false;
        break;
      case 'n':
        if (editable && sel?.type === 'node') this.openNoteEditor({ target: sel.id });
        else handled = false;
        break;
      case 'w':
        this.editor.cycleFlow();
        break;
      case 'm':
        this.editor.toggleNotes();
        break;
      case '\\':
        this.editor.toggleSource();
        break;
      case 'r':
        if (editable && sel?.type === 'edge') this.editor.commit(edits.reverseEdge(this.editor.text, sel.key));
        break;
      case 'a':
        if (editable) this.openAddForm({ group: sel?.type === 'group' ? sel.id : undefined });
        break;
      case 'g':
        if (editable) this.openAddForm({ kind: 'group' });
        break;
      case 'f':
        this.fit(true);
        break;
      case '0':
        this.zoomTo(1);
        break;
      case '+':
      case '=':
        this.zoomBy(1.2);
        break;
      case '-':
        this.zoomBy(1 / 1.2);
        break;
      case 'c':
        this.editor.toggleChanges();
        break;
      case '?':
        this.toggleHelp();
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  }
}
