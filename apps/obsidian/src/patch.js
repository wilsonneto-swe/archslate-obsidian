// PATCH: one method replaced by a wrapper, undone when the plugin unloads,
// written by hand. The plugin patches one method, WorkspaceLeaf.setViewState
// (AUTO-OPEN, as the Kanban and Mindslate plugins do).
//  - The wrapper calls the original through `wrap`, so other plugins' patches
//    of the same method keep working.
//  - Undo: when the method is still the wrapper, the original goes back. When
//    another plugin wrapped it after this one (its wrapper calls this one),
//    taking this one out would break that chain: the wrapper stays and becomes
//    a plain pass-through instead. Either way the plugin's code no longer runs.

/**
 * A method of `T` with the parameters and the result of `M`, called on an
 * instance of `T` as `this`. Its `call` and `apply` are typed: they run it on
 * `thisArg` and give back what it returns (TypeScript's own give any, as the
 * tsconfig leaves strictBindCallApply off).
 * @template T
 * @template {(...args: never[]) => unknown} M
 * @typedef {((this: T, ...args: Parameters<M>) => ReturnType<M>) & {
 *   call(thisArg: T, ...args: Parameters<M>): ReturnType<M>;
 *   apply(thisArg: T, args: Parameters<M>): ReturnType<M>;
 * }} Method
 */

/**
 * Replaces the method `target[key]` with `wrap(original)`; returns the undo.
 * @template {PropertyKey} K
 * @template {Record<K, (...args: never[]) => unknown>} T
 * @param {T} target
 * @param {K} key
 * @param {(original: Method<T, T[K]>) => Method<T, T[K]>} wrap
 * @returns {() => void}
 */
export function patchMethod(target, key, wrap) {
  /** @type {Method<T, T[K]>} */
  const original = target[key];
  if (typeof original !== 'function') throw new Error(`patchMethod: ${String(key)} is not a method`);
  const replacement = wrap(original);
  let active = true;
  /** @type {Method<T, T[K]>} */
  const patched = function patched(...args) {
    return active ? replacement.apply(this, args) : original.apply(this, args);
  };
  target[key] = patched;
  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    active = false;
    if (target[key] === patched) target[key] = original;
  };
}
