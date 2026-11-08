// Version strip under the canvas: saved snapshots in order, then "Now".
// Click a version to view it (read-only). Turn on "Changes" to compare the
// viewed version with the one before it; Shift+click picks a different base.

import { el, viewOf } from './dom.js';
import { icon } from './icons.js';
import { isComposing, modKey } from './keys.js';

/** @typedef {import('../types').Snapshot} Snapshot */
/** @typedef {import('./editor.js').DiagramEditor} DiagramEditor */
/** @typedef {import('../types').TimelineMode} TimelineMode */

/**
 * "Nov 8, 05:30 PM" in the user's locale; '' for a date that does not parse.
 * @param {string} iso
 * @returns {string}
 */
const formatDate = (iso) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export class Timeline {
  constructor(/** @type {DiagramEditor} */ editor) {
    this.editor = editor;
    /** @type {TimelineMode | null} */
    this.mode = null; // { type: 'save' } | { type: 'rename', id }
    /**
     * The version whose delete button waits for a second click.
     * @type {string | null}
     */
    this.pendingDelete = null;
    // Where focus goes back to when the form closes (the source, the canvas...).
    /** @type {HTMLElement | SVGElement | null} */
    this.returnFocus = null;
    this.root = el('footer', { class: 'sd-timeline', 'aria-label': 'Versions' });
  }

  // The form takes focus when it opens, and only then: the timeline is drawn
  // again on every edit, and a form left open must not pull focus back.
  openForm(/** @type {TimelineMode} */ mode) {
    /**
     * What has focus: an HTML or SVG element (the elements that can take it).
     * @type {HTMLElement | SVGElement | null}
     */
    const active = this.root.ownerDocument.activeElement;
    this.returnFocus = active && !this.root.contains(active) ? active : null;
    this.mode = mode;
    this.update(true);
    /** @type {HTMLInputElement | null} */
    const input = this.root.querySelector('.sd-tl-form input');
    input?.focus();
    input?.select();
  }

  openSave() {
    if (this.editor.readOnly) this.editor.viewVersion('now');
    this.openForm({ type: 'save' });
  }

  closeForm(/** @type {{ refocus?: boolean }} */ { refocus = true } = {}) {
    if (!this.mode) return;
    this.mode = null;
    this.update(true);
    const back = this.returnFocus;
    this.returnFocus = null;
    if (!refocus) return;
    if (back?.isConnected) back.focus({ preventScroll: true });
    else this.editor.canvas.focus();
  }

  reset() {
    this.mode = null;
    this.pendingDelete = null;
    this.returnFocus = null;
  }

  inlineInput(/** @type {{ value: string, placeholder: string, submitLabel: string, onSubmit: (name: string) => void }} */ { value, placeholder, submitLabel, onSubmit }) {
    const input = el('input', { class: 'sd-input', value, placeholder, 'aria-label': placeholder });
    const close = () => this.closeForm();
    const form = el(
      'form',
      { class: 'sd-tl-form' },
      input,
      el('button', { type: 'submit', class: 'sd-btn sd-primary', text: submitLabel }),
      el('button', { type: 'button', class: 'sd-btn', text: 'Cancel', onclick: close }),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      onSubmit(input.value.trim());
      close();
    });
    input.addEventListener('keydown', (event) => {
      if (isComposing(event) || event.metaKey || event.ctrlKey) return;
      event.stopPropagation();
      if (event.key === 'Escape') close();
    });
    // Focus moving somewhere else (the canvas, the source) closes the form. A
    // click that focuses nothing (Safari's buttons) leaves it open.
    form.addEventListener('focusout', (event) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || form.contains(next)) return;
      viewOf(form).setTimeout(() => {
        if (form.isConnected) this.closeForm({ refocus: false });
      });
    });
    return form;
  }

  update(/** @type {boolean} */ force = false) {
    const active = this.root.ownerDocument.activeElement;
    if (!force && this.root.contains(active) && active.tagName === 'INPUT') return;

    const { editor } = this;
    const { snapshots, version } = editor;
    const base = editor.baseSnapshot();
    const latest = snapshots.at(-1);
    const unchanged = latest && latest.text === editor.text;

    const saveControl =
      this.mode?.type === 'save'
        ? this.inlineInput({
            value: `v${snapshots.length + 1}`,
            placeholder: 'Version name',
            submitLabel: 'Save',
            onSubmit: (name) => editor.saveVersion(name),
          })
        : el(
            'button',
            {
              type: 'button',
              class: 'sd-btn sd-tl-save',
              title: unchanged ? `No changes since "${latest.name}"` : `Save the current diagram as a named version (${modKey('S')})`,
              disabled: unchanged,
              onclick: () => this.openSave(),
            },
            icon('bookmark'),
            el('span', { text: 'Save version' }),
          );

    const items = snapshots.map((snapshot) => this.item(snapshot, version === snapshot.id, base?.id === snapshot.id));
    items.push(
      el(
        'div',
        { class: `sd-tl-item sd-tl-now${version === 'now' ? ' is-active' : ''}` },
        el(
          'button',
          {
            type: 'button',
            class: 'sd-tl-main',
            title: unchanged || !latest ? 'Current diagram' : 'Current diagram, with unsaved changes since the last version',
            onclick: () => editor.viewVersion('now'),
          },
          el('span', { class: 'sd-tl-dot' }),
          el('span', { class: 'sd-tl-name', text: 'Now' }),
          !unchanged && latest ? el('span', { class: 'sd-tl-dirty', 'aria-label': 'unsaved changes' }) : null,
        ),
      ),
    );

    const changes = el(
      'button',
      {
        type: 'button',
        class: 'sd-btn sd-tl-changes',
        'aria-pressed': String(editor.changes),
        title: 'Highlight what changed since the previous version (C)',
        disabled: snapshots.length === 0,
        onclick: () => editor.toggleChanges(),
      },
      icon('diff'),
      el('span', { text: 'Changes' }),
    );

    this.root.replaceChildren(saveControl, el('div', { class: 'sd-tl-track' }, items), changes);
    this.root.querySelector('.sd-tl-item.is-active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  item(/** @type {Snapshot} */ snapshot, /** @type {boolean} */ active, /** @type {boolean} */ isBase) {
    const { editor } = this;
    if (this.mode?.type === 'rename' && this.mode.id === snapshot.id) {
      return el(
        'div',
        { class: 'sd-tl-item is-editing' },
        this.inlineInput({
          value: snapshot.name,
          placeholder: 'Version name',
          submitLabel: 'Rename',
          onSubmit: (name) => name && editor.renameVersion(snapshot.id, name),
        }),
      );
    }

    const deleting = this.pendingDelete === snapshot.id;
    const actions = active
      ? el(
          'span',
          { class: 'sd-tl-actions' },
          el(
            'button',
            {
              type: 'button',
              class: 'sd-btn sd-btn-icon',
              title: 'Rename version',
              'aria-label': 'Rename version',
              onclick: () => this.openForm({ type: 'rename', id: snapshot.id }),
            },
            icon('pencil', 14),
          ),
          el(
            'button',
            {
              type: 'button',
              class: `sd-btn sd-btn-icon sd-danger${deleting ? ' is-confirming' : ''}`,
              title: deleting ? 'Click again to delete' : 'Delete version',
              'aria-label': deleting ? 'Confirm delete' : 'Delete version',
              onclick: () => {
                if (deleting) {
                  this.pendingDelete = null;
                  editor.deleteVersion(snapshot.id);
                  return;
                }
                this.pendingDelete = snapshot.id;
                this.update(true);
                // The confirm button replaces this one: keep the keyboard on it.
                /** @type {HTMLButtonElement | null} */ (this.root.querySelector('.sd-danger.is-confirming'))?.focus();
                viewOf(this.root).setTimeout(() => {
                  if (this.pendingDelete === snapshot.id) {
                    this.pendingDelete = null;
                    this.update(true);
                  }
                }, 3000);
              },
            },
            deleting ? el('span', { text: 'Delete?' }) : icon('trash', 14),
          ),
        )
      : null;

    return el(
      'div',
      { class: `sd-tl-item${active ? ' is-active' : ''}${isBase ? ' is-base' : ''}` },
      el(
        'button',
        {
          type: 'button',
          class: 'sd-tl-main',
          title: `${snapshot.name}, saved ${formatDate(snapshot.createdAt)}. Shift+click to compare against it.`,
          onclick: (event) => {
            if (event.shiftKey) editor.setBase(snapshot.id);
            else editor.viewVersion(snapshot.id);
          },
        },
        el('span', { class: 'sd-tl-dot' }),
        el('span', { class: 'sd-tl-name', text: snapshot.name }),
      ),
      actions,
    );
  }
}

export { formatDate };
