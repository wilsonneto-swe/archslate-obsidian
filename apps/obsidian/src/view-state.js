// VIEW-STATE: each diagram opens again as it was left: the zoom and pan (or
// "fit"), the source pane's width or whether it is hidden, and the notes
// panel. One entry per note path, kept in the plugin's data (data.json in the
// plugin's folder: per vault and per device, never in the note).
//  - CAP: at most MAX_NOTES notes; the ones used longest ago go first.
//  - FOLLOW: a renamed or moved note (or folder) keeps its state; a deleted
//    note loses it.
//  - TOLERANT: whatever data.json holds (an older shape, a hand edit), a bad
//    entry is dropped, never thrown.

import { renamedPath } from './auto-open.js';

/** @typedef {import('../../../packages/types').StoredViewState} StoredViewState */
/** @typedef {import('../../../packages/types').StoredViewStates} StoredViewStates */
/** @typedef {import('../../../packages/types').StoredViewStatesInput} StoredViewStatesInput */
/** @typedef {import('../../../packages/types').ViewState} ViewState */
/** @typedef {import('../../../packages/types').ViewStateEntry} ViewStateEntry */

export const MAX_NOTES = 200;
export const STORE_VERSION = 1;

/**
 * A finite number (not NaN, not ±Infinity).
 * @param {unknown} n
 * @returns {n is number}
 */
const isNumber = (n) => typeof n === 'number' && Number.isFinite(n);

/**
 * A view state as kept: each field checked, a bad one replaced by its default.
 * @param {StoredViewState | null | undefined} value
 * @returns {ViewState | null} null when `value` is not an object
 */
function cleanState(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  const view = value.view;
  if (view && isNumber(view.k) && isNumber(view.tx) && isNumber(view.ty) && view.k > 0) out.view = { k: view.k, tx: view.tx, ty: view.ty };
  else out.view = null;
  out.codeWidth = typeof value.codeWidth === 'string' && /^\d+(\.\d+)?(px|%)$/.test(value.codeWidth) ? value.codeWidth : null;
  out.sourceHidden = value.sourceHidden === true;
  out.notes = typeof value.notes === 'boolean' ? value.notes : null;
  return out;
}

export class ViewStateStore {
  constructor(/** @type {StoredViewStatesInput | null | undefined} */ data) {
    /**
     * By note path, the one used longest ago first.
     * @type {Map<string, ViewStateEntry>}
     */
    this.notes = new Map();
    if (data && typeof data === 'object' && data.version === STORE_VERSION && data.notes && typeof data.notes === 'object') {
      for (const [path, entry] of Object.entries(data.notes)) {
        const state = cleanState(entry?.state);
        if (state && isNumber(entry.at)) this.notes.set(path, { state, at: entry.at });
      }
    }
  }

  get(/** @type {string} */ path) {
    return this.notes.get(path)?.state ?? null;
  }

  /** Returns true when something changed (so the data needs saving). */
  set(/** @type {string} */ path, /** @type {ViewState} */ state, /** @type {number} */ now = Date.now()) {
    const clean = cleanState(state);
    if (!clean) return false;
    const before = this.notes.get(path);
    if (before && JSON.stringify(before.state) === JSON.stringify(clean)) return false;
    this.notes.delete(path);
    this.notes.set(path, { state: clean, at: now });
    while (this.notes.size > MAX_NOTES) {
      /** @type {[string, ViewStateEntry] | null} */
      let oldest = null;
      for (const [key, entry] of this.notes) if (!oldest || entry.at < oldest[1].at) oldest = [key, entry];
      this.notes.delete(oldest[0]);
    }
    return true;
  }

  rename(/** @type {string} */ oldPath, /** @type {string} */ newPath) {
    let changed = false;
    for (const [path, entry] of [...this.notes]) {
      const to = renamedPath(path, oldPath, newPath);
      if (to === null) continue;
      this.notes.delete(path);
      this.notes.set(to, entry);
      changed = true;
    }
    return changed;
  }

  delete(/** @type {string} */ path) {
    let changed = false;
    for (const key of [...this.notes.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) {
        this.notes.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  toJSON() {
    return { version: STORE_VERSION, notes: Object.fromEntries(this.notes) };
  }
}
