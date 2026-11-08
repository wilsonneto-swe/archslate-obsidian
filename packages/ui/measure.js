// Text metrics for layout, measured with the same fonts the SVG uses, so node
// widths match what is drawn. The fonts here must stay in sync with styles.css.

import { viewOf } from './dom.js';

/**
 * Text widths in the fonts the editor draws with, around `element`.
 * @param {HTMLElement} element
 * @returns {import('../types').TextMeasurer}
 */
export function createMeasurer(element) {
  // A detached element has no computed font yet: use the page's.
  const source = element.isConnected ? element : element.ownerDocument.body;
  const family = viewOf(source).getComputedStyle(source).fontFamily || 'system-ui, sans-serif';
  // The main window's canvas: it lasts as long as the page, also when the
  // editor moves between Obsidian windows.
  const context = document.createElement('canvas').getContext('2d');
  /** @type {Record<import('../types').TextStyle, string>} */
  const fonts = {
    label: `600 13px ${family}`,
    caption: `400 11px ${family}`,
    edge: `500 11px ${family}`,
    title: `600 11.5px ${family}`,
    prop: `400 11px ${family}`,
    note: `400 11.5px ${family}`,
    count: `700 10.5px ${family}`,
    edgeProp: `400 10.5px ${family}`,
    badge: `700 10px ${family}`,
  };
  /** @type {Map<string, number>} */
  const cache = new Map();
  return (text, style) => {
    const key = `${style}\u0000${text}`;
    let width = cache.get(key);
    if (width === undefined) {
      context.font = fonts[style] ?? fonts.label;
      width = context.measureText(text).width;
      cache.set(key, width);
    }
    return width;
  };
}
