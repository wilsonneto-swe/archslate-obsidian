// PATCH: one method replaced by a wrapper, undone when the plugin unloads,
// written by hand. The plugin patches one method, WorkspaceLeaf.setViewState
// (AUTO-OPEN, as the Kanban and Mindslate plugins do).
//  - The wrapper calls the original through `wrap`, so other plugins' patches
//    of the same method keep working.
//  - Undo: when the method is still the wrapper, the original goes back. When
//    another plugin wrapped it after this one (its wrapper calls this one),
//    taking this one out would break that chain: the wrapper stays and becomes
//    a plain pass-through instead. Either way the plugin's code no longer runs.

export function patchMethod(target, key, wrap) {
  const original = target[key];
  if (typeof original !== 'function') throw new Error(`patchMethod: ${String(key)} is not a method`);
  const replacement = wrap(original);
  let active = true;
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
