// The command-line tool of the agent skill (skills/system-design-diagram): it
// reads and writes diagram notes with Archslate's own parser and file format,
// so what it writes is exactly what the plugin and the web version read.
// Built into one dependency-free file by `npm run build:skill`.
//
//   archslate validate <note.md>                 outline + problems (exit 1 on problems)
//   archslate new <note.md> [--from <file>|-]    a new diagram note from source text
//   archslate set <note.md> [--from <file>|-]    replace the diagram, keep the rest of the note
//   archslate version <note.md> --name "<name>"  save the current diagram as a named version
//   archslate source <note.md>                   print the diagram's source
//
// It never deletes a note: `new` refuses a file that exists, and `set` keeps
// the note's text and its versions.
//
// Exit codes: 0 fine, 1 the diagram has problems (nothing written), 2 bad usage
// or a file that cannot be read or written.
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KINDS, OPS } from '../../packages/core/kinds.js';
import { parse } from '../../packages/core/parser.js';
import { hasFlag, newEnvelope, parseNote, serializeNote } from '../../packages/core/document.js';

const USAGE = `usage:
  archslate validate <note.md>
  archslate new <note.md> [--from <source file> | --from -]
  archslate set <note.md> [--from <source file> | --from -]
  archslate version <note.md> --name "<version name>"
  archslate source <note.md>`;

const FLAG_HINT = 'the note has no "archslate: diagram" property: Obsidian opens it as Markdown (and draws the block). Run "Archslate: Always open this note as a diagram" there, or add the property, to open it as a diagram.';

class UsageError extends Error {}

function readText(path) {
  if (path === '-') return readFileSync(0, 'utf8');
  if (!existsSync(path)) throw new UsageError(`${path}: no such file`);
  return readFileSync(path, 'utf8');
}

// Source text as the editor holds it: no BOM, "\n" line endings (the note's
// own line endings are kept when it is written).
const sourceText = (text) => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');

function option(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  if (i + 1 >= args.length) throw new UsageError(`${name} needs a value`);
  return args[i + 1];
}

// Control characters from a note are shown as \u001b, never sent to the terminal.
const printable = (text) => String(text).replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function outline(model) {
  const out = [];
  const describe = (node) => {
    const kind = KINDS[node.kind]?.label ?? node.kind;
    const count = node.count ? ` x${node.count}` : '';
    const props = node.props.length ? ` [${node.props.join(', ')}]` : '';
    return `${node.id} (${kind}${count})${node.label !== node.id ? ` "${node.label}"` : ''}${props}`;
  };
  const walk = (groupId, depth) => {
    for (const node of model.nodes.filter((n) => n.group === groupId)) out.push(`${'  '.repeat(depth)}- ${describe(node)}`);
    for (const group of model.groups.filter((g) => g.parent === groupId)) {
      out.push(`${'  '.repeat(depth)}- group ${group.id} "${group.label}"`);
      walk(group.id, depth + 1);
    }
  };
  out.push(`direction ${model.direction}`, `components (${model.nodes.length}):`);
  walk(null, 1);
  out.push(`links (${model.edges.length}):`);
  for (const edge of model.edges) {
    const props = edge.props.length ? ` [${edge.props.join(', ')}]` : '';
    out.push(`  - ${edge.from} ${edge.op} ${edge.to} (${OPS[edge.op].name})${edge.label ? `: ${edge.label}` : ''}${props}`);
  }
  if (model.notes.length) {
    out.push(`notes (${model.notes.length}):`);
    for (const note of model.notes) out.push(`  - on ${note.target}: ${note.text}`);
  }
  if (model.flows.length) {
    out.push(`flows (${model.flows.length}):`);
    for (const flow of model.flows) out.push(`  - ${flow.id} "${flow.label}": ${flow.steps.length} steps`);
  }
  if (model.markdown.trim()) out.push(`markdown: ${model.markdown.trim().split('\n').length} lines below the diagram`);
  return out.join('\n');
}

function problems(model, offset) {
  return model.errors.map((e) => `line ${e.line + 1 + offset}: ${e.message}`);
}

// What `new` and `set` refuse to write: nothing to draw, or a whole note where
// the block's content was meant.
function refuseSource(source, model) {
  const lines = source.split('\n');
  const first = lines.find((line) => line.trim() !== '')?.trim();
  if (first === '---' || lines.some((line) => /^ {0,3}(`{3,}|~{3,})[ \t]*archslate[ \t]*$/.test(line))) {
    return 'this looks like a whole note: give only the diagram source (what is inside the ```archslate block; "archslate source <note>" prints it)';
  }
  if (model.nodes.length === 0 && model.groups.length === 0) return 'the source has no components: nothing to draw';
  return null;
}

export function run(argv, io = { out: console.log, err: console.error }) {
  const out = (text) => io.out(printable(text));
  const err = (text) => io.err(printable(text));
  const [command, file, ...rest] = argv;
  try {
    if (!command || command === '--help' || command === '-h') {
      out(USAGE);
      return command ? 0 : 2;
    }
    if (!file) throw new UsageError(`${command}: which note?`);

    if (command === 'validate' || command === 'source') {
      const content = readText(file);
      const { doc, envelope } = parseNote(content);
      if (!envelope.hasBlock) {
        err(`${file}: no \`\`\`archslate block found (the diagram is the first one at the note's top level, not inside a callout or a list)`);
        return 1;
      }
      if (command === 'source') {
        out(doc.text.replace(/\n$/, ''));
        return 0;
      }
      const model = parse(doc.text);
      out(outline(model));
      out(`versions (${doc.snapshots.length})${doc.snapshots.length ? `: ${doc.snapshots.map((s) => s.name).join(', ')}` : ''}`);
      if (!hasFlag(content)) out(`note: ${FLAG_HINT}`);
      const found = problems(model, envelope.blockLine + 1);
      if (model.nodes.length === 0 && model.groups.length === 0) found.push('the diagram has no components');
      if (found.length) {
        err(`${found.length} problem${found.length === 1 ? '' : 's'}:\n${found.join('\n')}`);
        return 1;
      }
      out('ok: no problems');
      return 0;
    }

    if (command === 'new' || command === 'set') {
      if (rest.includes('--force')) throw new UsageError(`${command}: there is no --force: the tool never replaces a note. Use set to change a note's diagram (its text and versions stay), or pick another file name for a new note`);
      const from = option(rest, '--from');
      if (from === null) throw new UsageError(`${command}: give the diagram source with --from <file> or --from -`);
      const source = sourceText(readText(from));
      const model = parse(source);
      const found = problems(model, 0);
      if (found.length) {
        err(`the source has ${found.length} problem${found.length === 1 ? '' : 's'} (line numbers in the source):\n${found.join('\n')}\nnothing was written`);
        return 1;
      }
      const refused = refuseSource(source, model);
      if (refused) {
        err(`${refused}\nnothing was written`);
        return 1;
      }
      const text = source.endsWith('\n') ? source : `${source}\n`;
      if (command === 'new') {
        if (existsSync(file)) throw new UsageError(`${file} exists: use set to change its diagram (the note's text and versions stay), or pick another file name`);
        writeFileSync(file, serializeNote({ text, snapshots: [] }, newEnvelope()));
        out(`wrote ${file}: ${model.nodes.length} components, ${model.edges.length} links`);
        return 0;
      }

      const content = readText(file);
      const { doc, envelope } = parseNote(content);
      const old = parse(doc.text);
      // The notes below "---" in the note stay unless the new source has its own.
      const ownNotes = model.markdown.trim() !== '';
      const keepNotes = !ownNotes && old.markdown.trim() !== '';
      const diagram = model.markdownLine >= 0 ? `${model.lines.slice(0, model.markdownLine).join('\n')}\n` : text;
      const next = keepNotes ? `${diagram}---\n${old.markdown}` : ownNotes ? text : diagram;
      writeFileSync(file, serializeNote({ text: next, snapshots: doc.snapshots }, envelope));
      const replaced = ownNotes && old.markdown.trim() ? ` (the notes below the diagram were replaced: ${old.markdown.trim().split('\n').length} lines before, ${model.markdown.trim().split('\n').length} now)` : '';
      out(`${envelope.hasBlock ? 'updated' : 'added a diagram block to'} ${file}: ${model.nodes.length} components, ${model.edges.length} links${replaced}`);
      if (!hasFlag(content)) out(`note: ${FLAG_HINT}`);
      return 0;
    }

    if (command === 'version') {
      const name = option(rest, '--name');
      if (!name?.trim()) throw new UsageError('version: give it a --name');
      const { doc, envelope } = parseNote(readText(file));
      if (!envelope.hasBlock) throw new UsageError(`${file}: no \`\`\`archslate block, so there is no diagram to save a version of`);
      const snapshot = { id: `v-${Date.now().toString(36)}`, name: name.trim(), text: doc.text, createdAt: new Date().toISOString() };
      writeFileSync(file, serializeNote({ text: doc.text, snapshots: [...doc.snapshots, snapshot] }, envelope));
      out(`saved version "${snapshot.name}" (${doc.snapshots.length + 1} in ${file})`);
      return 0;
    }

    throw new UsageError(`unknown command "${command}"\n${USAGE}`);
  } catch (error) {
    err(error instanceof UsageError ? error.message : `error: ${error.message}`);
    return 2;
  }
}

// Run as a program (also through a symlink or under another name).
function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = run(process.argv.slice(2));
}
