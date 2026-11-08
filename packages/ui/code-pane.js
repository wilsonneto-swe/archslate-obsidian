// Source editor: a plain textarea over a syntax-highlighted mirror. Typing goes
// to the textarea (native caret, IME, selection); the mirror underneath draws
// colours, error squiggles, the selected component's line and diff highlights.

import { tokenizeLine, isCountWord } from '../core/parser.js';
import { resolveKind } from '../core/kinds.js';
import { el, viewOf } from './dom.js';
import { isComposing } from './keys.js';

/** @typedef {import('../types').CodePaneHandlers} CodePaneHandlers */
/** @typedef {import('../types').CodePaneState} CodePaneState */
/** @typedef {import('../types').LinkOp} LinkOp */
/** @typedef {import('../types').ParseError} ParseError */
/** @typedef {import('../types').Token} Token */

/**
 * What highlightMarkdown() carries from one line to the next: whether the
 * lines so far opened a fenced code block that is not closed yet.
 * @typedef {{ fence: boolean }} MarkdownState
 */

const INDENT = '  ';
const KEYWORDS = new Set(['group', 'direction', 'flow', 'note']);
/** @type {Record<LinkOp, string>} */
const ARROW_CLASS = { '->': 'sd-tok-request', '-->': 'sd-tok-event', '<->': 'sd-tok-connection' };

/**
 * The class of each of a line's tokens ('' for none), from its type and place.
 * @param {Token[]} tokens
 * @returns {string[]}
 */
function classify(tokens) {
  /** @type {string[]} */
  const classes = new Array(tokens.length).fill('');
  const [first, second] = tokens;
  if (!first) return classes;
  if (second?.type === 'arrow') {
    classes[0] = 'sd-tok-id';
    classes[2] = tokens[2]?.type === 'word' ? 'sd-tok-id' : '';
  } else if (first.type === 'word') {
    const keyword = KEYWORDS.has(first.value);
    classes[0] = keyword ? 'sd-tok-keyword' : resolveKind(first.value) ? 'sd-tok-kind' : '';
    if (second?.type === 'word') classes[1] = first.value === 'direction' ? 'sd-tok-keyword' : 'sd-tok-id';
    if (!keyword) {
      tokens.forEach((token, i) => {
        if (i > 1 && token.type === 'word' && isCountWord(token.value)) classes[i] = 'sd-tok-count';
      });
    }
  }
  tokens.forEach((token, i) => {
    if (token.type === 'string') classes[i] = 'sd-tok-string';
    if (token.type === 'text') classes[i] = 'sd-tok-label';
    if (token.type === 'props') classes[i] = 'sd-tok-props';
    if (token.type === 'colon' || token.type === 'lbrace' || token.type === 'rbrace') classes[i] = 'sd-tok-punct';
    if (token.type === 'arrow') classes[i] = ARROW_CLASS[token.value] ?? 'sd-tok-request';
  });
  return classes;
}

// Light markdown colouring for the notes below "---". Text is never changed,
// only wrapped, so the mirror stays aligned with the textarea.
/**
 * @param {string} line
 * @param {MarkdownState} state
 * @returns {Array<string | HTMLSpanElement | null>}
 */
function highlightMarkdown(line, state) {
  /** @type {(cls: string, text: string) => HTMLSpanElement | null} */
  const span = (cls, text) => (text ? el('span', { class: cls, text }) : null);
  if (/^\s*(```|~~~)/.test(line)) {
    state.fence = !state.fence;
    return [span('sd-md-fence', line)];
  }
  if (state.fence) return [span('sd-md-code', line)];
  const heading = line.match(/^(\s{0,3}#{1,6}\s+)(.*)$/);
  if (heading) return [span('sd-md-mark', heading[1]), span('sd-md-heading', heading[2])];
  const prefix = line.match(/^(\s*)(>\s?|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/);
  /** @type {Array<string | HTMLSpanElement | null>} */
  const parts = [];
  let rest = line;
  if (prefix) {
    parts.push(prefix[1], span('sd-md-mark', prefix[2]));
    rest = line.slice(prefix[0].length);
  }
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\|)/g;
  let last = 0;
  for (const m of rest.matchAll(pattern)) {
    parts.push(rest.slice(last, m.index));
    parts.push(span(m[1] ? 'sd-md-code' : m[2] ? 'sd-md-strong' : 'sd-md-mark', m[0]));
    last = m.index + m[0].length;
  }
  parts.push(rest.slice(last));
  return parts.filter((part) => part !== null && part !== '');
}

/**
 * A diagram source line as coloured spans, with its errors underlined.
 * @param {string} line
 * @param {ParseError[]} errors
 * @returns {Array<string | HTMLSpanElement>}
 */
function highlightLine(line, errors) {
  const { tokens, comment } = tokenizeLine(line);
  const classes = classify(tokens);
  const spans = tokens.map((token, i) => ({ start: token.start, end: token.end, cls: classes[i] }));
  if (comment) spans.push({ ...comment, cls: 'sd-tok-comment' });

  // Paint character classes, then overlay error ranges.
  /** @type {string[]} */
  const cls = new Array(line.length).fill('');
  for (const span of spans) for (let i = span.start; i < span.end; i += 1) cls[i] = span.cls;
  /** @type {boolean[]} */
  const bad = new Array(line.length).fill(false);
  for (const error of errors) {
    const end = Math.max(error.end, error.start + 1);
    for (let i = error.start; i < Math.min(end, line.length); i += 1) bad[i] = true;
  }

  /** @type {Array<string | HTMLSpanElement>} */
  const parts = [];
  let i = 0;
  while (i < line.length) {
    let j = i + 1;
    while (j < line.length && cls[j] === cls[i] && bad[j] === bad[i]) j += 1;
    const className = [cls[i], bad[i] ? 'sd-tok-error' : ''].filter(Boolean).join(' ');
    parts.push(className ? el('span', { class: className, text: line.slice(i, j) }) : line.slice(i, j));
    i = j;
  }
  // An error at end of line (e.g. "expected a name") still needs a marker.
  if (errors.some((e) => e.start >= line.length)) parts.push(el('span', { class: 'sd-tok-error sd-tok-eol', text: ' ' }));
  return parts;
}

export class CodePane {
  constructor(/** @type {CodePaneHandlers} */ { onInput, onCaretLine, onUndo, onRedo, onEscape }) {
    this.handlers = { onInput, onCaretLine, onUndo, onRedo, onEscape };
    this.textarea = el('textarea', { class: 'sd-code-input', wrap: 'off', 'aria-label': 'Diagram source' });
    // Ids and kinds are not words: no spellcheck, autocorrect, smart quotes or
    // suggestions (iOS needs each one spelled out as an attribute).
    for (const [name, value] of [['spellcheck', 'false'], ['autocorrect', 'off'], ['autocapitalize', 'off'], ['autocomplete', 'off'], ['writingsuggestions', 'false']]) {
      this.textarea.setAttribute(name, value);
    }
    this.mirror = el('div', { class: 'sd-code-mirror', 'aria-hidden': 'true' });
    this.gutter = el('div', { class: 'sd-code-gutter', 'aria-hidden': 'true' });
    this.problems = el('div', { class: 'sd-code-problems' });
    this.status = el('span', { class: 'sd-code-status' });
    this.banner = el('div', { class: 'sd-code-banner', hidden: true });

    this.root = el(
      'section',
      { class: 'sd-code' },
      el('header', { class: 'sd-pane-header' }, el('span', { class: 'sd-pane-title', text: 'Source' }), this.status),
      this.banner,
      el(
        'div',
        { class: 'sd-code-body' },
        this.gutter,
        el('div', { class: 'sd-code-scroll' }, this.mirror, this.textarea),
      ),
      this.problems,
    );

    this.lastCaretLine = -1;
    this.textarea.addEventListener('input', () => this.handlers.onInput(this.textarea.value));
    this.textarea.addEventListener('scroll', () => this.syncScroll());
    this.textarea.addEventListener('keydown', (event) => this.onKeyDown(event));
    this.textarea.addEventListener('beforeinput', (event) => {
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        event.preventDefault();
        (event.inputType === 'historyUndo' ? this.handlers.onUndo : this.handlers.onRedo)();
      }
    });
    const caret = () => this.reportCaret();
    this.textarea.addEventListener('keyup', caret);
    this.textarea.addEventListener('click', caret);
    this.textarea.addEventListener('focus', caret);
  }

  get focused() {
    return this.textarea.ownerDocument.activeElement === this.textarea;
  }

  caretLine() {
    return this.textarea.value.slice(0, this.textarea.selectionStart).split('\n').length - 1;
  }

  reportCaret() {
    const line = this.caretLine();
    if (line !== this.lastCaretLine) {
      this.lastCaretLine = line;
      this.handlers.onCaretLine(line);
    }
  }

  onKeyDown(/** @type {KeyboardEvent} */ event) {
    const ta = this.textarea;
    // Keys that confirm an input method's composition are not edits.
    if (ta.readOnly || isComposing(event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.handlers.onEscape();
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) this.handlers.onRedo();
      else this.handlers.onUndo();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      this.handlers.onRedo();
      return;
    }

    const { selectionStart: start, selectionEnd: end, value } = ta;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;

    if (event.key === 'Tab' && !mod) {
      event.preventDefault();
      if (start === end && !event.shiftKey) {
        this.replace(start, end, INDENT, start + INDENT.length);
        return;
      }
      // Indent or outdent every selected line.
      const blockEnd = value.indexOf('\n', end - (end > start && value[end - 1] === '\n' ? 1 : 0));
      const stop = blockEnd === -1 ? value.length : blockEnd;
      const block = value.slice(lineStart, stop).split('\n');
      const changed = block.map((line) => {
        if (!event.shiftKey) return INDENT + line;
        return line.startsWith(INDENT) ? line.slice(INDENT.length) : line.replace(/^\s/, '');
      });
      const text = changed.join('\n');
      this.replace(lineStart, stop, text, lineStart, lineStart + text.length);
      return;
    }

    if (event.key === 'Enter' && !mod && start === end) {
      event.preventDefault();
      const current = value.slice(lineStart, start);
      let indent = current.match(/^\s*/)[0];
      if (current.trimEnd().endsWith('{')) indent += INDENT;
      this.replace(start, end, `\n${indent}`, start + 1 + indent.length);
      return;
    }

    if (event.key === '}' && !mod && start === end) {
      const current = value.slice(lineStart, start);
      if (current.trim() === '' && current.length >= INDENT.length) {
        event.preventDefault();
        const outdented = current.slice(INDENT.length);
        this.replace(lineStart, start, `${outdented}}`, lineStart + outdented.length + 1);
      }
    }
  }

  replace(/** @type {number} */ start, /** @type {number} */ end, /** @type {string} */ text, /** @type {number} */ caretStart, /** @type {number} */ caretEnd = caretStart) {
    const ta = this.textarea;
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
    ta.setSelectionRange(caretStart, caretEnd);
    this.handlers.onInput(ta.value);
    this.reportCaret();
  }

  syncScroll() {
    const { scrollTop, scrollLeft } = this.textarea;
    this.mirror.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    this.gutter.style.transform = `translateY(${-scrollTop}px)`;
  }

  // `lineMarks` maps line number -> extra class (selection, diff status).
  update(/** @type {CodePaneState} */ { text, model, readOnly, lineMarks, banner, onJump }) {
    const ta = this.textarea;
    if (ta.value !== text) {
      const { selectionStart, selectionEnd } = ta;
      ta.value = text;
      if (this.focused) ta.setSelectionRange(selectionStart, selectionEnd);
    }
    ta.readOnly = readOnly;
    this.root.classList.toggle('is-readonly', readOnly);

    /** @type {Map<number, ParseError[]>} */
    const errorsByLine = new Map();
    for (const error of model.errors) {
      if (!errorsByLine.has(error.line)) errorsByLine.set(error.line, []);
      errorsByLine.get(error.line).push(error);
    }

    const lines = text.split('\n');
    /** @type {HTMLDivElement[]} */
    const rows = [];
    /** @type {HTMLDivElement[]} */
    const numbers = [];
    /** @type {MarkdownState} */
    const markdown = { fence: false };
    lines.forEach((line, i) => {
      const errors = errorsByLine.get(i) ?? [];
      const marks = lineMarks.get(i) ?? '';
      /** @type {HTMLSpanElement | Array<string | HTMLSpanElement | null>} */
      let content;
      if (model.markdownLine >= 0 && i === model.markdownLine) content = el('span', { class: 'sd-tok-separator', text: line });
      else if (model.markdownLine >= 0 && i > model.markdownLine) content = highlightMarkdown(line, markdown);
      else content = highlightLine(line, errors);
      const section = model.markdownLine >= 0 && i > model.markdownLine ? ' is-markdown' : '';
      rows.push(el('div', { class: `sd-code-line${section} ${marks}`.trim() }, content, '\n'));
      numbers.push(
        el('div', {
          class: `sd-code-number${errors.length ? ' has-error' : ''} ${marks}`.trim(),
          text: String(i + 1),
          title: errors.map((e) => e.message).join('\n') || null,
        }),
      );
    });
    this.mirror.replaceChildren(...rows);
    this.gutter.replaceChildren(...numbers);
    this.syncScroll();

    const count = model.errors.length;
    this.status.textContent = readOnly ? 'read-only' : count ? `${count} problem${count > 1 ? 's' : ''}` : '';
    this.status.classList.toggle('has-error', count > 0 && !readOnly);
    this.problems.replaceChildren(
      ...model.errors.slice(0, 50).map((error) =>
        el(
          'button',
          { class: 'sd-problem', type: 'button', onclick: () => onJump(error.line, error.start) },
          el('span', { class: 'sd-problem-line', text: `${error.line + 1}` }),
          el('span', { text: error.message }),
        ),
      ),
    );
    this.problems.hidden = count === 0;

    this.banner.hidden = !banner;
    if (banner) this.banner.replaceChildren(banner);
  }

  revealLine(/** @type {number} */ line) {
    if (this.focused) return;
    const lineHeight = parseFloat(viewOf(this.textarea).getComputedStyle(this.textarea).lineHeight) || 20;
    const top = line * lineHeight;
    const { scrollTop, clientHeight } = this.textarea;
    if (top < scrollTop + lineHeight || top > scrollTop + clientHeight - 2 * lineHeight) {
      this.textarea.scrollTop = Math.max(0, top - clientHeight / 3);
    }
  }

  jumpTo(/** @type {number} */ line, /** @type {number} */ column = 0) {
    const lines = this.textarea.value.split('\n');
    let offset = 0;
    for (let i = 0; i < line; i += 1) offset += lines[i].length + 1;
    this.textarea.focus();
    this.textarea.setSelectionRange(offset + column, offset + column);
    this.reportCaret();
  }
}
