// The file format: a diagram is an ordinary Markdown note.
//
//   ---
//   archslate: diagram                 <- the flag: open this note as a diagram
//   ---
//
//   ```archslate
//   service api                        <- the diagram's source
//   ...
//   ```
//
//   ## Notes                           <- real Markdown: links, tags, embeds
//
//   %% archslate:versions
//   {"name":"v1","createdAt":"…","id":"…","text":"…"}
//   %%
//
// Read as a note (Obsidian's reading view, GitHub, any editor) it shows the
// diagram as a code block (Obsidian draws it) followed by the notes; the saved
// versions sit in a comment at the end, one JSON line each, so saving a version
// adds one line to a git diff.
//
// The editor never sees this layout. It works on { text, snapshots }, where
// `text` is the diagram source, then a "---" line and the notes when there are
// any. parseNote() keeps everything around the diagram (frontmatter, text
// before the block, line endings, a BOM) in an envelope, and serializeNote()
// puts it back, so a note that is opened and not edited is written back byte
// for byte (opening never rewrites a note).

/** @typedef {import('../types').DiagramDocument} DiagramDocument */
/** @typedef {import('../types').Envelope} Envelope */
/** @typedef {import('../types').OpenedFile} OpenedFile */
/** @typedef {import('../types').ParsedNote} ParsedNote */
/** @typedef {import('../types').Snapshot} Snapshot */

/**
 * A saved version as read back from a note's versions comment or a JSON backup:
 * isSnapshot() checks its text and name, normalizeSnapshot() its id and date.
 * @typedef {{ text: string, name: string, id?: unknown, createdAt?: unknown }} StoredSnapshot
 */

/**
 * A JSON backup of an earlier build, as parsed: readDiagramFile() checks its
 * text and snapshots.
 * @typedef {{ text?: unknown, snapshots?: unknown }} StoredBackup
 */

export const FLAG_KEY = 'archslate';
export const FLAG_VALUE = 'diagram';
export const LANGUAGE = 'archslate';
const VERSIONS_OPEN = '%% archslate:versions';
const VERSIONS_CLOSE = '%%';
const SEPARATOR = '---';
const BOM = '﻿';

// The block may be indented up to three spaces, as Markdown allows.
const FENCE_OPEN = new RegExp(`^( {0,3})(\`{3,}|~{3,})[ \\t]*${LANGUAGE}[ \\t]*$`);
const ANY_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** @type {(line: string) => boolean} */
const isBlank = (line) => line.trim() === '';

// ------------------------------------------------------------------ helpers

/**
 * @param {string} content
 * @returns {{ bom: string, eol: Envelope['eol'], lines: string[] }}
 */
function splitText(content) {
  const bom = content.startsWith(BOM) ? BOM : '';
  const body = bom ? content.slice(1) : content;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  return { bom, eol, lines: body.split(/\r?\n/) };
}

// Line index of the frontmatter's closing "---", or -1.
/**
 * @param {string[]} lines
 * @returns {number}
 */
function frontmatterEnd(lines) {
  if (lines[0] !== SEPARATOR) return -1;
  for (let i = 1; i < lines.length; i += 1) if (lines[i] === SEPARATOR) return i;
  return -1;
}

/**
 * @param {string} line
 * @param {string} open the opening fence ("```", "~~~~"...)
 * @returns {boolean}
 */
function closesFence(line, open) {
  const trimmed = line.trim();
  return trimmed.length >= open.length && trimmed === open[0].repeat(trimmed.length);
}

// "%%" marks an Obsidian comment; one inside a code span doesn't count.
/** @type {(line: string) => number} */
const commentMarks = (line) => line.replace(/(`+)[^`]*?\1/g, '').split('%%').length - 1;

// The diagram: the first ```archslate block at the top level of the note. One
// inside another code block (an example) or a comment (an old diagram) is text.
/**
 * The line of the block's opening fence, the fence's indent and the fence; null
 * when the note has no such block.
 * @param {string[]} lines
 * @param {number} from
 * @returns {{ line: number, indent: string, fence: string } | null}
 */
function findBlock(lines, from) {
  /** @type {string | null} */
  let fence = null;
  /** @type {'%%' | '<!--' | null} */
  let comment = null;
  for (let i = from; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      if (closesFence(line, fence)) fence = null;
    } else if (comment === '%%') {
      if (commentMarks(line) % 2 === 1) comment = null;
    } else if (comment === '<!--') {
      if (line.includes('-->')) comment = null;
    } else {
      const block = line.match(FENCE_OPEN);
      if (block) return { line: i, indent: block[1], fence: block[2] };
      const other = line.match(ANY_FENCE);
      if (other && !(other[1][0] === '`' && other[2].includes('`'))) fence = other[1];
      else if (commentMarks(line) % 2 === 1) comment = '%%';
      else if (line.lastIndexOf('<!--') > line.lastIndexOf('-->')) comment = '<!--';
    }
  }
  return null;
}

/**
 * The versions on a versions comment's lines; null when a line (blank ones
 * aside) is not a version.
 * @param {string[]} lines
 * @returns {Snapshot[] | null}
 */
function readVersionLines(lines) {
  /** @type {Snapshot[]} */
  const snapshots = [];
  for (const line of lines) {
    if (isBlank(line)) continue;
    /** @type {unknown} */
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      return null;
    }
    if (!isSnapshot(value)) return null;
    snapshots.push(normalizeSnapshot(value, snapshots.length));
  }
  return snapshots;
}

// The saved versions: the last "%% archslate:versions" comment after the
// diagram that holds only version lines. It normally ends the note; text added
// after it (a footnote, a line appended by another plugin) is read as notes,
// and the next save puts the versions back at the end.
/**
 * The lines of the comment's opening and closing marks, and its versions.
 * @param {string[]} lines
 * @param {number} from
 * @returns {{ start: number, end: number, snapshots: Snapshot[] } | null}
 */
function findVersions(lines, from) {
  for (let open = lines.length - 1; open >= from; open -= 1) {
    if (lines[open].trim() !== VERSIONS_OPEN) continue;
    let close = open + 1;
    while (close < lines.length && lines[close].trim() !== VERSIONS_CLOSE) close += 1;
    if (close >= lines.length) continue;
    const snapshots = readVersionLines(lines.slice(open + 1, close));
    if (snapshots) return { start: open, end: close, snapshots };
  }
  return null;
}

/**
 * @param {unknown} value
 * @returns {value is StoredSnapshot}
 */
function isSnapshot(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.text === 'string' && typeof value.name === 'string';
}

/**
 * @param {StoredSnapshot} value
 * @param {number} index its place in the list, for the id it gets when it has none
 * @returns {Snapshot}
 */
function normalizeSnapshot(value, index) {
  return {
    id: typeof value.id === 'string' && value.id ? value.id : `imported-${index + 1}`,
    name: value.name,
    text: value.text,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
  };
}

// "%" is escaped so that no "%%" inside a version can end Obsidian's comment.
/**
 * @param {Snapshot} snapshot
 * @returns {string}
 */
function versionLine({ name, createdAt, id, text }) {
  return JSON.stringify({ name, createdAt, id, text }).replace(/%/g, '\\u0025');
}

/**
 * A backtick fence (three at least) longer than any line of backticks in the source.
 * @param {string[]} sourceLines
 * @returns {string}
 */
function fenceFor(sourceLines) {
  let longest = 2;
  for (const line of sourceLines) {
    const run = line.trim().match(/^`+$/);
    if (run) longest = Math.max(longest, run[0].length);
  }
  return '`'.repeat(longest + 1);
}

// The editor's text: the source, then "---" and the notes when there are any.
/**
 * @param {string[]} source
 * @param {string[]} notes
 * @returns {string}
 */
function editorText(source, notes) {
  if (notes.some((line) => !isBlank(line))) return `${source.join('\n')}\n${SEPARATOR}\n${notes.join('\n')}`;
  return source.length ? `${source.join('\n')}\n` : '';
}

/**
 * The editor's text split back into the source's lines and the notes' lines
 * (null when there is no "---" line).
 * @param {string} text
 * @returns {{ source: string[], notes: string[] | null }}
 */
function splitEditorText(text) {
  const lines = text.split('\n');
  const separator = lines.findIndex((line) => line.trim() === SEPARATOR);
  if (separator < 0) {
    if (lines.at(-1) === '') lines.pop();
    return { source: lines, notes: null };
  }
  return { source: lines.slice(0, separator), notes: lines.slice(separator + 1) };
}

// ---------------------------------------------------------------- reading

// Reads a note: { doc: { text, snapshots }, envelope }.
/**
 * @param {string} content
 * @returns {ParsedNote}
 */
export function parseNote(content) {
  const { bom, eol, lines } = splitText(content);
  const fmEnd = frontmatterEnd(lines);
  const bodyStart = fmEnd + 1;
  const block = findBlock(lines, bodyStart);

  let close = -1;
  if (block) {
    close = block.line + 1;
    while (close < lines.length && !closesFence(lines[close], block.fence)) close += 1;
    if (close >= lines.length) close = -1;
  }
  const versions = findVersions(lines, close >= 0 ? close + 1 : block ? block.line + 1 : bodyStart);
  const notesEnd = versions ? versions.start : lines.length;
  // After the versions: kept as notes when there is text there.
  const after = versions ? lines.slice(versions.end + 1) : [];
  const tail = after.some((line) => !isBlank(line)) ? after : [];

  /** @type {string[]} */
  let source = [];
  /** @type {string[]} */
  let notes;
  /** @type {string[]} */
  let prefix = [];
  let indent = '';
  if (block) {
    indent = block.indent;
    // An unclosed block runs to the versions (or the end of the note).
    const sourceEnd = close >= 0 ? close : notesEnd;
    source = lines.slice(block.line + 1, sourceEnd).map((line) => unindent(line, indent));
    prefix = lines.slice(bodyStart, block.line);
    notes = [...lines.slice(Math.min(close >= 0 ? close + 1 : sourceEnd, notesEnd), notesEnd), ...tail];
  } else {
    notes = [...lines.slice(bodyStart, notesEnd), ...tail];
  }

  const text = editorText(source, notes);
  const hasVersions = Boolean(versions?.snapshots.length);
  /** @type {Envelope} */
  const envelope = {
    bom,
    eol,
    frontmatter: fmEnd >= 0 ? lines.slice(0, fmEnd + 1) : null,
    prefix,
    fence: block ? block.fence : null,
    indent,
    hasBlock: Boolean(block),
    // The line of the opening fence (from the top of the note), or -1.
    blockLine: block ? block.line : -1,
    // What this note was read as, to give back unchanged when nothing changed,
    // and the version lines as written, kept while the versions are the same.
    text,
    versionLines: hasVersions ? lines.slice(versions.start, versions.end + 1) : null,
    snapshotKey: hasVersions ? JSON.stringify(versions.snapshots) : null,
    original: content,
  };
  return { doc: { text, snapshots: versions ? versions.snapshots : [] }, envelope };
}

/**
 * A line of the block without the block's indent (as many of its spaces as the
 * line has).
 * @param {string} line
 * @param {string} indent
 * @returns {string}
 */
function unindent(line, indent) {
  let cut = 0;
  while (cut < indent.length && line[cut] === ' ') cut += 1;
  return line.slice(cut);
}

// The source of the block a note opens with (the one the editor edits), or
// null when the note has none at its top level.
/**
 * @param {string} content
 * @returns {string | null}
 */
export function blockSource(content) {
  const { lines } = splitText(content);
  const block = findBlock(lines, frontmatterEnd(lines) + 1);
  if (!block) return null;
  /** @type {string[]} */
  const source = [];
  for (let i = block.line + 1; i < lines.length && !closesFence(lines[i], block.fence); i += 1) source.push(unindent(lines[i], block.indent));
  return source.join('\n');
}

// The flag, as the note's frontmatter has it.
/**
 * @param {string} content
 * @returns {boolean}
 */
export function hasFlag(content) {
  const { lines } = splitText(content);
  const end = frontmatterEnd(lines);
  if (end < 0) return false;
  const flag = new RegExp(`^["']?${FLAG_KEY}["']?[ \\t]*:[ \\t]*["']?${FLAG_VALUE}["']?[ \\t]*$`);
  return lines.slice(1, end).some((line) => flag.test(line));
}

// ---------------------------------------------------------------- writing

// The envelope of a brand-new diagram note: just the flag.
/** @returns {Envelope} */
export function newEnvelope() {
  return {
    bom: '',
    eol: '\n',
    frontmatter: [SEPARATOR, `${FLAG_KEY}: ${FLAG_VALUE}`, SEPARATOR],
    prefix: [''],
    fence: null,
    indent: '',
    hasBlock: false,
    text: null,
    versionLines: null,
    snapshotKey: null,
    original: null,
  };
}

// The envelope without the copies of the note it keeps for byte-exact saves:
// what a host stores next to the document (the web app, in localStorage).
/**
 * Takes what it can from an envelope or a stored one (missing fields get their
 * defaults); null for anything that is not an object.
 * @param {Partial<Envelope> | null | undefined} envelope
 * @returns {Envelope | null}
 */
export function slimEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const { bom = '', eol = '\n', frontmatter = null, prefix = [], fence = null, indent = '', hasBlock = false } = envelope;
  return { bom, eol, frontmatter, prefix, fence, indent, hasBlock, text: null, versionLines: null, snapshotKey: null, original: null };
}

/**
 * The note for a document, in the envelope it was read with (a new note by
 * default). An unchanged document gives back the note exactly as it was read.
 * @param {{ text: string, snapshots?: Snapshot[] }} doc
 * @param {Envelope} [envelope]
 * @returns {string}
 */
export function serializeNote({ text, snapshots = [] }, envelope = newEnvelope()) {
  const snapshotKey = snapshots.length ? JSON.stringify(snapshots.map(normalizeSnapshot)) : null;
  if (envelope.original && text === envelope.text && snapshotKey === envelope.snapshotKey) {
    return envelope.original;
  }

  const { source, notes } = splitEditorText(text);
  const out = envelope.frontmatter ? [...envelope.frontmatter] : [];
  out.push(...(envelope.prefix ?? []));
  const hasSource = source.some((line) => !isBlank(line));
  if (hasSource || envelope.hasBlock) {
    const indent = envelope.indent ?? '';
    const fence = envelope.fence && !source.some((line) => closesFence(line, envelope.fence)) ? envelope.fence : fenceFor(source);
    out.push(`${indent}${fence}${LANGUAGE}`, ...source.map((line) => (line ? indent + line : line)), indent + fence);
    if (notes === null) out.push('');
  }
  if (notes !== null) out.push(...notes);
  else if (!hasSource && !envelope.hasBlock) out.push('');

  if (snapshots.length) {
    while (out.length && isBlank(out.at(-1))) out.pop();
    // Versions that did not change keep their lines exactly as they were written.
    const lines = snapshotKey === envelope.snapshotKey && envelope.versionLines ? envelope.versionLines : [VERSIONS_OPEN, ...snapshots.map(versionLine), VERSIONS_CLOSE];
    out.push('', ...lines, '');
  }
  return envelope.bom + out.join(envelope.eol);
}

// The note a new diagram (or an exported one) starts as.
/**
 * @param {DiagramDocument} doc
 * @returns {string}
 */
export function serializeNewNote(doc) {
  return serializeNote(doc, newEnvelope());
}

// ------------------------------------------------------------ any old file

// Reads any file the app can open: a diagram note (.md), a bare source file
// (.sd, .txt), or the JSON backups of earlier builds. Returns { doc, envelope }
// (envelope is null for the formats that are not notes). Throws an Error with
// a readable message for anything else.
/**
 * @param {string} content
 * @param {string} [filename]
 * @returns {OpenedFile}
 */
export function readDiagramFile(content, filename = '') {
  if (content.includes('\u0000')) throw new Error(`${filename || 'This file'} is not a text file.`);
  if (/\.json$/i.test(filename) || content.trimStart().startsWith('{')) {
    /** @type {StoredBackup | null} */
    let value;
    try {
      value = /** @type {(text: string) => StoredBackup | null} */ (JSON.parse)(content);
    } catch {
      if (/\.json$/i.test(filename)) throw new Error(`${filename} is not valid JSON.`);
      value = null;
    }
    if (value !== null) {
      if (typeof value?.text !== 'string') throw new Error(`${filename || 'This file'} is not a diagram backup.`);
      const snapshots = Array.isArray(value.snapshots) ? value.snapshots.filter(isSnapshot).map(normalizeSnapshot) : [];
      return { doc: { text: value.text, snapshots }, envelope: null };
    }
  }
  const note = parseNote(content);
  const isNote = /\.(md|markdown)$/i.test(filename) || note.envelope.hasBlock || note.envelope.frontmatter !== null;
  if (isNote) return note;
  return { doc: { text: content.replace(/\r\n?/g, '\n'), snapshots: [] }, envelope: null };
}
