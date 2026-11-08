// Shortcut labels as each platform writes them: ⌘S on a Mac, an iPhone or an
// iPad, Ctrl+S elsewhere. The host says which (host.appleKeys): Obsidian knows
// its platform, the web app asks the browser.

let apple = false;

/**
 * @param {boolean} [value] true for ⌘S, false for Ctrl+S
 * @returns {void}
 */
export function useAppleKeys(value) {
  apple = Boolean(value);
}

// The modifier on its own: ⌘ or Ctrl.
/** @returns {string} */
export const modName = () => (apple ? '⌘' : 'Ctrl');

/**
 * A shortcut's label: modKey('Z', { shift: true }) is "⇧⌘Z" or "Ctrl+Shift+Z".
 * @param {string} key
 * @param {{ shift?: boolean }} [options]
 * @returns {string}
 */
export function modKey(key, { shift = false } = {}) {
  return apple ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}

// A key the user is composing with an input method (Japanese, Chinese...):
// Enter, Escape or Tab then confirm the composition, not the field.
/**
 * @param {KeyboardEvent} event
 * @returns {boolean}
 */
export const isComposing = (event) => event.isComposing || event.keyCode === 229;
