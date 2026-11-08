// Tiny element builders. No innerHTML anywhere: user text only ever reaches the
// DOM through textContent, which is also what Obsidian's plugin review expects.

const SVG_NS = 'http://www.w3.org/2000/svg';

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
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function el(tag, props, ...children) {
  const node = document.createElement(tag);
  apply(node, props, false);
  append(node, children);
  return node;
}

export function svg(tag, props, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  apply(node, props, true);
  append(node, children);
  return node;
}

// The window an element lives in. Obsidian can move views into pop-out
// windows, where the global `window` and `document` are the wrong ones.
export function viewOf(node) {
  return node?.ownerDocument?.defaultView ?? window;
}

export function setAttrs(node, attrs) {
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
}
