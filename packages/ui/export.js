// Export the drawn diagram as a standalone SVG or a PNG, and the document as a
// file. The canvas is styled with CSS variables from the theme, so the export
// copies every element's computed style inline: the file looks exactly like
// the screen (light or dark) and needs no stylesheet.

import { el, viewOf } from './dom.js';

/** @typedef {import('../types').SvgImage} SvgImage */

/**
 * A node of the drawn diagram, told apart by its nodeType as markup() does: an
 * element (1; HTML and SVG elements have an inline style, a plain Element has
 * none), text (3), or anything else, such as a comment (8), which is left out.
 * @typedef {(Element & { style?: CSSStyleDeclaration }) | (Text & { nodeType: 3 }) | (Comment & { nodeType: 8 })} DrawnNode
 */

const STYLE_PROPS = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-opacity',
  'opacity',
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'text-decoration',
  'display',
  'visibility',
];

const SVG_NS = 'http://www.w3.org/2000/svg';

// "translate(12px, 30px)" (CSS) -> "translate(12 30)" (SVG attribute), so the
// file also renders in tools that ignore CSS transforms.
/**
 * @param {string} value a CSS transform
 * @returns {string | null} its translate in px, as an SVG transform; null when it has none
 */
function cssTranslate(value) {
  const m = value.match(/translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\s*\)/);
  return m ? `translate(${m[1]} ${m[2]})` : null;
}

// Characters XML does not allow (control characters, half of an emoji's
// surrogate pair) would make the file unreadable: they are dropped.
/**
 * @param {string} text
 * @returns {string}
 */
function xmlChars(text) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        out += text[i] + text[i + 1];
        i += 1;
      }
    } else if (!((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0xdc00 && code <= 0xdfff) || code === 0xfffe || code === 0xffff)) {
      out += text[i];
    }
  }
  return out;
}
/**
 * Text as XML character data.
 * @param {string} text
 * @returns {string}
 */
const escapeText = (text) => xmlChars(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/**
 * Text as a double-quoted XML attribute value.
 * @param {string} text
 * @returns {string}
 */
const escapeAttr = (text) => escapeText(text).replace(/"/g, '&quot;');

// Attributes that only matter on screen (hit testing, selection, source lines).
const SKIP_ATTRIBUTE = /^(class|style|data-.*|role|aria-.*|tabindex)$/;

// Writes the SVG markup of a drawn element with its computed style inline. It
// is built as text rather than by cloning and restyling nodes, so a strict
// Content-Security-Policy (no inline styles) has nothing to object to.
/**
 * @param {DrawnNode} element
 * @returns {string}
 */
function markup(element) {
  if (element.nodeType === 3) return escapeText(element.nodeValue);
  if (element.nodeType !== 1) return '';
  const tag = element.localName;
  if (tag === 'title') return '';
  if (element.matches('.sd-edge-hit')) return '';
  /**
   * The attributes to write, each as `name="value"`.
   * @type {string[]}
   */
  const attributes = [];
  for (const { name, value } of element.attributes) {
    if (!SKIP_ATTRIBUTE.test(name) && name !== 'transform') attributes.push(`${name}="${escapeAttr(value)}"`);
  }
  const transforms = [element.style?.transform ? cssTranslate(element.style.transform) : null, element.getAttribute('transform')].filter(Boolean);
  if (transforms.length) attributes.push(`transform="${escapeAttr(transforms.join(' '))}"`);
  const computed = viewOf(element).getComputedStyle(element);
  const style = STYLE_PROPS.map((prop) => [prop, computed.getPropertyValue(prop)])
    .filter(([, value]) => value && value !== 'normal' && value !== 'auto')
    .map(([prop, value]) => `${prop}:${value}`)
    .join(';');
  if (style) attributes.push(`style="${escapeAttr(style)}"`);
  const children = [...element.childNodes].map(markup).join('');
  return `<${tag}${attributes.length ? ` ${attributes.join(' ')}` : ''}>${children}</${tag}>`;
}

// Builds a self-contained SVG string of everything currently drawn.
/**
 * @param {import('./renderer.js').DiagramRenderer} renderer
 * @param {import('../types').Layout} layout
 * @param {string} background a CSS colour
 * @param {number} [padding]
 * @returns {SvgImage}
 */
export function diagramSvg(renderer, layout, background, padding = 28) {
  const { bounds } = layout;
  const x = bounds.x - padding;
  const y = bounds.y - padding;
  const w = Math.ceil(bounds.w + 2 * padding);
  const h = Math.ceil(bounds.h + 2 * padding);
  const layers = [...renderer.viewport.children].map(markup).join('');
  const text =
    `<svg xmlns="${SVG_NS}" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}">` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${escapeAttr(background)}"/>` +
    `<g>${layers}</g></svg>`;
  return { text, width: w, height: h };
}

/**
 * @param {SvgImage} svg
 * @param {number} [scale]
 * @returns {Promise<Blob>}
 */
export function svgToPng(svg, scale = 2) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(svg.width * scale);
      canvas.height = Math.round(svg.height * scale);
      const context = canvas.getContext('2d');
      context.scale(scale, scale);
      context.drawImage(image, 0, 0, svg.width, svg.height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encoding failed'))), 'image/png');
    };
    image.onerror = () => reject(new Error('Could not draw the SVG'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.text)}`;
  });
}

// The web page's way to save a file (in Obsidian, host.saveFile writes exports
// to the vault instead).
/**
 * @param {Blob} blob
 * @param {string} filename
 * @returns {void}
 */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// "# Orders platform, v3: outbox" -> "orders-platform".
/**
 * @param {string} text
 * @param {string} [fallback]
 * @returns {string}
 */
export function fileBaseName(text, fallback = 'diagram') {
  const first = text.split('\n').find((line) => line.trim() !== '');
  const title = first?.match(/^\s*(?:#|\/\/)\s*(.+)$/)?.[1].split(/[,:;(]/)[0] ?? '';
  const slug = title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}
