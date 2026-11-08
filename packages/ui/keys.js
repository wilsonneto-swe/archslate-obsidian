// Shortcut labels as each platform writes them: ⌘S on a Mac, an iPhone or an
// iPad, Ctrl+S elsewhere. The host says which (host.appleKeys): Obsidian knows
// its platform, the web app asks the browser.

let apple = false;

export function useAppleKeys(value) {
  apple = Boolean(value);
}

// The modifier on its own: ⌘ or Ctrl.
export const modName = () => (apple ? '⌘' : 'Ctrl');

export function modKey(key, { shift = false } = {}) {
  return apple ? `${shift ? '⇧' : ''}⌘${key}` : `Ctrl+${shift ? 'Shift+' : ''}${key}`;
}

// A key the user is composing with an input method (Japanese, Chinese...):
// Enter, Escape or Tab then confirm the composition, not the field.
export const isComposing = (event) => event.isComposing || event.keyCode === 229;
