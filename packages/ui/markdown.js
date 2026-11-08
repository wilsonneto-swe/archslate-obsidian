// A small markdown renderer for the notes under a diagram. It builds DOM nodes
// directly (never innerHTML), so text from the document can't inject markup.
// Inside Obsidian the host can pass its own renderer instead (see editor.js).
//
// Blocks: headings, paragraphs, lists (nested, ordered, tasks), quotes, fenced
// code, tables, rules. Inline: **bold**, *italic*, ~~strike~~, ==highlight==,
// `code`, [links](https://…), <https://…>, bare URLs, [[wikilinks]] as text.

import { el } from './dom.js';

/**
 * A list item as its list is read: its text (lazy continuation lines joined
 * with "\n") and the lines indented under it, rendered as nested blocks.
 * @typedef {{ text: string, sub: string[] }} ListItem
 */

/**
 * A block read from the lines: its element, and the index of the line after it.
 * @template {HTMLElement} E
 * @typedef {{ node: E, next: number }} ParsedBlock
 */

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s*(```+|~~~+)\s*([\w+-]*)/;
// A heading's closing #s are trimmed by headingText(), not by the pattern: a
// pattern that does both backtracks for a long time on a long line.
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
// Tested on trimmed lines.
const TABLE_RULE = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/;
// Quotes and lists nest; past this depth the rest is shown as plain text.
const MAX_DEPTH = 40;
const SAFE_URL = /^(https?:|mailto:)/i;

/**
 * @param {string} line
 * @returns {number} the width of the line's leading whitespace, a tab counting as four
 */
const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, '    ').length;
/**
 * @param {string} line
 * @returns {boolean}
 */
const isBlank = (line) => line.trim() === '';

/**
 * @param {string[]} lines
 * @param {number} i
 * @returns {boolean}
 */
function isTableStart(lines, i) {
  return lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && TABLE_RULE.test(lines[i + 1].trim());
}

// "## Title ##" -> "Title"; a # that is part of the text ("C#") stays.
/**
 * @param {string} [rest] the text after the heading's opening #s (undefined for a bare "##")
 * @returns {string}
 */
function headingText(rest = '') {
  let end = rest.length;
  while (end > 0 && /\s/.test(rest[end - 1])) end -= 1;
  let hashes = end;
  while (hashes > 0 && rest[hashes - 1] === '#') hashes -= 1;
  if (hashes < end && (hashes === 0 || /\s/.test(rest[hashes - 1]))) end = hashes;
  return rest.slice(0, end).trim();
}

/**
 * @param {string[]} lines
 * @param {number} i
 * @returns {boolean} whether line i starts a block other than a paragraph
 */
function startsBlock(lines, i) {
  const line = lines[i];
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || LIST.test(line) || isTableStart(lines, i);
}

/**
 * @param {string} line a table row
 * @returns {string[]} its cells, trimmed ("\|" is a | inside a cell)
 */
function splitRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  /** @type {string[]} */
  const cells = [];
  let current = '';
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === '\\' && row[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (row[i] === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += row[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

// ------------------------------------------------------------------ inline

// A link's text never holds another link (that is also what keeps a bare URL,
// whose text is the URL itself, from being linked again and again).
/**
 * @param {string} text
 * @param {string} href
 * @param {{ plain?: boolean }} [options] plain: the text as is, without inline markdown
 * @returns {HTMLAnchorElement | HTMLSpanElement} a span when the URL isn't http(s) or mailto
 */
function link(text, href, { plain = false } = {}) {
  const body = plain ? text : inline(text, { links: false });
  if (!SAFE_URL.test(href)) return el('span', {}, body);
  return el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, body);
}

/**
 * Inline markdown as text and elements, to append to a block.
 * @param {string} text
 * @param {{ links?: boolean }} [options] links: false inside a link's own text
 * @returns {Array<string | HTMLElement>}
 */
export function inline(text, { links = true } = {}) {
  /** @type {Array<string | HTMLElement>} */
  const out = [];
  let buffer = '';
  /** @returns {void} */
  const flush = () => {
    if (buffer) out.push(buffer);
    buffer = '';
  };
  /**
   * @param {HTMLElement} node
   * @param {number} next the index to go on from
   * @returns {number} next
   */
  const emit = (node, next) => {
    flush();
    out.push(node);
    return next;
  };
  /**
   * The text from `i` to the next `marker`, as a `tag` element.
   * @param {number} i the index of the opening marker
   * @param {string} marker
   * @param {'strong' | 'del' | 'mark' | 'em'} tag
   * @returns {number} the index after the closing marker, or -1 (none, or space just inside the markers)
   */
  const wrapped = (i, marker, tag) => {
    const close = text.indexOf(marker, i + marker.length + 1);
    if (close < 0) return -1;
    const inner = text.slice(i + marker.length, close);
    if (inner.trim() !== inner) return -1;
    return emit(el(tag, {}, inline(inner, { links })), close + marker.length);
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const prev = text[i - 1] ?? ' ';
    let next = -1;
    if (c === '\\' && /[\\`*_{}[\]()#+\-.!~=|<>]/.test(text[i + 1] ?? '')) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (c === '\n') {
      next = emit(el('br'), i + 1);
    } else if (c === '`') {
      const run = text.slice(i).match(/^`+/)[0];
      const close = text.indexOf(run, i + run.length);
      if (close > 0) next = emit(el('code', { text: text.slice(i + run.length, close).trim() || text.slice(i + run.length, close) }), close + run.length);
    } else if (text.startsWith('**', i) || text.startsWith('__', i)) {
      next = wrapped(i, text.slice(i, i + 2), 'strong');
    } else if (text.startsWith('~~', i)) {
      next = wrapped(i, '~~', 'del');
    } else if (text.startsWith('==', i)) {
      next = wrapped(i, '==', 'mark');
    } else if ((c === '*' || (c === '_' && !/[\p{L}\p{N}]/u.test(prev))) && text[i + 1] && text[i + 1] !== ' ') {
      next = wrapped(i, c, 'em');
    } else if (text.startsWith('[[', i)) {
      const close = text.indexOf(']]', i + 2);
      if (close > 0) {
        const target = text.slice(i + 2, close);
        next = emit(el('span', { class: 'sd-md-wikilink', text: target.split('|').at(-1) }), close + 2);
      }
    } else if (links && c === '[') {
      const m = text.slice(i).match(/^\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/);
      if (m) next = emit(link(m[1], m[2]), i + m[0].length);
    } else if (links && c === '<') {
      const m = text.slice(i).match(/^<((?:https?:\/\/|mailto:)[^>\s]+)>/i);
      if (m) next = emit(link(m[1], m[1], { plain: true }), i + m[0].length);
    } else if (links && c === 'h' && !/[\p{L}\p{N}]/u.test(prev)) {
      const m = text.slice(i).match(/^https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"]/);
      if (m) next = emit(link(m[0], m[0], { plain: true }), i + m[0].length);
    }
    if (next >= 0) {
      i = next;
    } else {
      buffer += c;
      i += 1;
    }
  }
  flush();
  return out;
}

// ------------------------------------------------------------------ blocks

/**
 * @param {string} text the item's text; "[ ] …" or "[x] …" makes it a task
 * @returns {HTMLLIElement}
 */
function listItem(text) {
  const task = text.match(/^\[([ xX])\]\s+(.*)$/s);
  if (!task) return el('li', {}, inline(text));
  const checked = task[1] !== ' ';
  return el(
    'li',
    { class: `sd-md-task${checked ? ' is-done' : ''}` },
    el('input', { type: 'checkbox', checked, disabled: true, 'aria-label': checked ? 'done' : 'to do' }),
    ' ',
    inline(task[2]),
  );
}

/**
 * @param {string[]} lines
 * @param {number} start the index of the list's first item
 * @param {number} depth how deep the list is nested in quotes and lists
 * @returns {ParsedBlock<HTMLOListElement | HTMLUListElement>}
 */
function parseList(lines, start, depth) {
  const base = indentOf(lines[start]);
  const ordered = /\d/.test(lines[start].match(LIST)[2]);
  /** @type {ListItem[]} */
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      let j = i + 1;
      while (j < lines.length && isBlank(lines[j])) j += 1;
      const resumes = j < lines.length && (indentOf(lines[j]) > base || (LIST.test(lines[j]) && indentOf(lines[j]) === base));
      if (!resumes) break;
      if (indentOf(lines[j]) > base && items.length) items.at(-1).sub.push('');
      i = j;
      continue;
    }
    const m = line.match(LIST);
    const indent = indentOf(line);
    if (m && indent === base) {
      items.push({ text: m[3], sub: [] });
    } else if (indent > base && items.length) {
      items.at(-1).sub.push(line);
    } else if (!m && indent >= base && items.length && !startsBlock(lines, i)) {
      items.at(-1).text += `\n${line.trim()}`;
    } else {
      break;
    }
    i += 1;
  }

  const first = Number.parseInt(lines[start].match(LIST)[2], 10);
  const list = el(ordered ? 'ol' : 'ul', ordered && first !== 1 ? { start: first } : {});
  for (const item of items) {
    const li = listItem(item.text);
    const sub = item.sub;
    if (sub.some((line) => !isBlank(line))) {
      const cut = Math.min(...sub.filter((line) => !isBlank(line)).map(indentOf));
      li.append(renderBlocks(sub.map((line) => line.replace(/\t/g, '    ').slice(cut)), depth + 1));
    }
    list.append(li);
  }
  return { node: list, next: i };
}

/**
 * @param {string[]} lines
 * @param {number} start the index of the header row (the delimiter row follows it)
 * @returns {ParsedBlock<HTMLDivElement>}
 */
function parseTable(lines, start) {
  const header = splitRow(lines[start]);
  const align = splitRow(lines[start + 1]).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
  /**
   * @param {'th' | 'td'} tag
   * @param {string} text
   * @param {number} index the column
   * @returns {HTMLTableCellElement}
   */
  const cell = (tag, text, index) => el(tag, { style: align[index] ? { textAlign: align[index] } : null }, inline(text));
  /** @type {HTMLTableRowElement[]} */
  const body = [];
  let i = start + 2;
  while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) {
    const cells = splitRow(lines[i]);
    body.push(el('tr', {}, header.map((_, index) => cell('td', cells[index] ?? '', index))));
    i += 1;
  }
  const table = el(
    'table',
    {},
    el('thead', {}, el('tr', {}, header.map((text, index) => cell('th', text, index)))),
    body.length ? el('tbody', {}, body) : null,
  );
  return { node: el('div', { class: 'sd-md-table' }, table), next: i };
}

/**
 * @param {string[]} lines
 * @param {number} [depth] how deep these lines are nested in quotes and lists
 * @returns {DocumentFragment}
 */
function renderBlocks(lines, depth = 0) {
  const fragment = document.createDocumentFragment();
  if (depth > MAX_DEPTH) {
    fragment.append(el('p', { text: lines.join('\n') }));
    return fragment;
  }
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      /** @type {string[]} */
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i += 1;
      fragment.append(el('pre', {}, el('code', { class: fence[2] ? `language-${fence[2]}` : null, text: body.join('\n') })));
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      fragment.append(el(`h${heading[1].length}`, {}, inline(headingText(heading[2]))));
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      fragment.append(el('hr'));
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      /** @type {string[]} */
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ''));
      fragment.append(el('blockquote', {}, renderBlocks(body, depth + 1)));
      continue;
    }

    if (isTableStart(lines, i)) {
      const { node, next } = parseTable(lines, i);
      fragment.append(node);
      i = next;
      continue;
    }

    if (LIST.test(line)) {
      const { node, next } = parseList(lines, i, depth);
      fragment.append(node);
      i = next;
      continue;
    }

    const paragraph = [line.trim()];
    i += 1;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) paragraph.push(lines[i++].trim());
    fragment.append(el('p', {}, inline(paragraph.join('\n'))));
  }
  return fragment;
}

/**
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function renderMarkdown(text) {
  return renderBlocks(text.replace(/\r/g, '').split('\n'));
}
