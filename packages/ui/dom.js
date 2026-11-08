// Tiny element builders. No innerHTML anywhere: user text only ever reaches the
// DOM through textContent, which is also what Obsidian's plugin review expects.
//
// Elements are made by the main window's `document`, also for a view Obsidian
// has moved into a pop-out window: appended there, they are adopted into the
// pop-out's document and keep this window's classes, so checks such as
// `instanceof Node` hold. An element made by the pop-out's own document (its
// `activeDocument`) belongs to the pop-out's JavaScript realm and fails them.

/** @typedef {import('../types').DomChild} DomChild */
/** @typedef {import('../types').DomProps} DomProps */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Sets `props` on a new element: `on…` listeners, `style`, `text`, then the
 * rest as properties (HTML elements) or attributes.
 * @param {HTMLElement | SVGElement} node
 * @param {DomProps | null | undefined} props
 * @param {boolean} isSvg
 * @returns {void}
 */
function apply(node, props, isSvg) {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key === 'text') {
      node.textContent = value;
    } else if (!isSvg && key in node && key !== 'list' && key !== 'form') {
      node[key] = value;
    } else if (value === true) {
      node.setAttribute(key, '');
    } else if (typeof value === 'string' || typeof value === 'number') {
      node.setAttribute(key, String(value));
    }
  }
}

/**
 * Appends `children` to a new element, flattened; text becomes text nodes.
 * @param {HTMLElement | SVGElement} node
 * @param {DomChild[]} children
 * @returns {void}
 */
function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/**
 * An HTML element: `el('button', { class: 'sd-btn', onclick }, icon, 'Save')`.
 * @template {string} K
 * @param {K} tag
 * @param {DomProps | null} [props]
 * @param {...DomChild} children
 * @returns {K extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[K] : HTMLElement}
 */
export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  apply(node, props, false);
  append(node, children);
  return node;
}

/**
 * An SVG element; props are always set as attributes.
 * @template {string} K
 * @param {K} tag
 * @param {DomProps | null} [props]
 * @param {...DomChild} children
 * @returns {K extends keyof SVGElementTagNameMap ? SVGElementTagNameMap[K] : SVGElement}
 */
export function svg(tag, props, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  apply(node, props, true);
  append(node, children);
  return node;
}

// The window an element lives in. Obsidian can move views into pop-out
// windows, where the global `window` and `document` are the wrong ones.
/**
 * @param {Node | null | undefined} node
 * @returns {Window & typeof globalThis}
 */
export function viewOf(node) {
  return node?.ownerDocument?.defaultView ?? window;
}

/**
 * @param {Element} node
 * @param {Record<string, string | number>} attrs
 * @returns {void}
 */
export function setAttrs(node, attrs) {
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
}
