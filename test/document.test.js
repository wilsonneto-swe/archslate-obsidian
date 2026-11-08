import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasFlag, parseNote, readDiagramFile, serializeNewNote, serializeNote, slimEnvelope } from '../packages/core/document.js';
import { parse } from '../packages/core/parser.js';
import { EXAMPLE_DOCUMENT } from '../apps/web/src/example.js';

const NOTE = `---
archslate: diagram
tags: [system-design]
---

\`\`\`archslate
service api
db store
api -> store
\`\`\`

## Notes

Uses [[Postgres]] and a %% comment %%.

%% archslate:versions
{"name":"v1","createdAt":"2026-11-01T14:00:00.000Z","id":"a","text":"service api\\n"}
%%
`;

test('a note reads as the diagram source, then its notes, plus the versions', () => {
  const { doc, envelope } = parseNote(NOTE);
  assert.equal(doc.text, 'service api\ndb store\napi -> store\n---\n\n## Notes\n\nUses [[Postgres]] and a %% comment %%.\n');
  assert.deepEqual(doc.snapshots, [{ id: 'a', name: 'v1', text: 'service api\n', createdAt: '2026-11-01T14:00:00.000Z' }]);
  assert.deepEqual(envelope.frontmatter, ['---', 'archslate: diagram', 'tags: [system-design]', '---']);
  const model = parse(doc.text);
  assert.deepEqual(model.errors, []);
  assert.equal(model.nodes.length, 2);
  assert.ok(model.markdown.includes('[[Postgres]]'));
});

test('opening and saving without a change gives back the same bytes', () => {
  for (const content of [
    NOTE,
    NOTE.replace(/\n/g, '\r\n'),
    `﻿${NOTE}`,
    '# Just a note\n\nNo diagram here.\n',
    '```archslate\nservice a\n```',
    '---\narchslate: diagram\n---\n',
    '',
  ]) {
    const { doc, envelope } = parseNote(content);
    assert.equal(serializeNote(doc, envelope), content, JSON.stringify(content));
  }
});

test('edits rewrite only the block and the versions; everything else is kept', () => {
  const { doc, envelope } = parseNote(NOTE);
  const text = doc.text.replace('db store', 'db store [Postgres]');
  const snapshots = [...doc.snapshots, { id: 'b', name: 'v2 "100%"', createdAt: '2026-11-02T00:00:00.000Z', text }];
  const out = serializeNote({ text, snapshots }, envelope);
  assert.ok(out.startsWith('---\narchslate: diagram\ntags: [system-design]\n---\n\n```archslate\nservice api\ndb store [Postgres]\n'));
  assert.ok(out.includes('\n```\n\n## Notes\n\nUses [[Postgres]] and a %% comment %%.\n\n%% archslate:versions\n'));
  assert.ok(!out.split('%% archslate:versions')[1].slice(0, -4).includes('%%'), 'no %% inside the versions comment');
  assert.ok(out.endsWith('\n%%\n'));
  const again = parseNote(out);
  assert.equal(again.doc.text, text);
  assert.deepEqual(again.doc.snapshots.map((s) => s.name), ['v1', 'v2 "100%"']);
  assert.equal(serializeNote(again.doc, again.envelope), out, 'stable');

  const crlf = parseNote(NOTE.replace(/\n/g, '\r\n'));
  assert.ok(!serializeNote({ ...crlf.doc, text }, crlf.envelope).replace(/\r\n/g, '').includes('\n'), 'keeps CRLF');
});

test('a plain note opened as a diagram keeps its text as the notes', () => {
  const plain = '# Caching\n\nRead-through vs write-through.\n';
  const { doc, envelope } = parseNote(plain);
  assert.equal(parse(doc.text).nodes.length, 0);
  assert.ok(parse(doc.text).markdown.includes('Read-through'));
  const out = serializeNote({ ...doc, text: `cache c\n${doc.text}` }, envelope);
  assert.equal(out, '```archslate\ncache c\n\n```\n# Caching\n\nRead-through vs write-through.\n');
});

test('a new note has the flag and a block; empty diagrams write no block', () => {
  const note = serializeNewNote({ text: 'service a\n', snapshots: [] });
  assert.equal(note, '---\narchslate: diagram\n---\n\n```archslate\nservice a\n```\n');
  assert.ok(hasFlag(note));
  assert.ok(!hasFlag('---\ntags: x\n---\n'));
  assert.ok(hasFlag('---\n"archslate": "diagram"\n---\n'));
  assert.equal(serializeNewNote({ text: '', snapshots: [] }), '---\narchslate: diagram\n---\n\n');
});

test('a source line made of backticks gets a longer fence', () => {
  const out = serializeNewNote({ text: 'service a\n```\n', snapshots: [] });
  assert.ok(out.includes('````archslate\nservice a\n```\n````'));
  assert.equal(parseNote(out).doc.text, 'service a\n```\n');
});

test('damaged versions are kept as text, never dropped', () => {
  const broken = `${NOTE.split('%% archslate:versions')[0]}%% archslate:versions\n{oops\n%%\n`;
  const { doc, envelope } = parseNote(broken);
  assert.deepEqual(doc.snapshots, []);
  assert.ok(doc.text.includes('{oops'));
  assert.equal(serializeNote(doc, envelope), broken);
});

test('readDiagramFile opens notes, bare source files and old JSON backups', () => {
  assert.equal(readDiagramFile(NOTE, 'x.md').doc.snapshots.length, 1);
  assert.deepEqual(readDiagramFile('service a\r\nservice b', 'x.sd'), { doc: { text: 'service a\nservice b', snapshots: [] }, envelope: null });
  const backup = JSON.stringify({ text: 'service a', snapshots: [{ name: 'v1', text: 'x' }, { bogus: true }] });
  assert.deepEqual(readDiagramFile(backup, 'b.json').doc.snapshots.map((s) => [s.id, s.name]), [['imported-1', 'v1']]);
  assert.throws(() => readDiagramFile('{"hello": 1}', 'x.json'), /not a diagram backup/);
  assert.throws(() => readDiagramFile('{oops', 'x.json'), /not valid JSON/);
  assert.throws(() => readDiagramFile('PNG\u0000', 'x.png'), /not a text file/);
});

test('the example survives a note round trip', () => {
  const note = serializeNewNote(EXAMPLE_DOCUMENT);
  const { doc } = parseNote(note);
  assert.equal(doc.text, EXAMPLE_DOCUMENT.text);
  assert.deepEqual(doc.snapshots, EXAMPLE_DOCUMENT.snapshots);
});

test('text added after the versions comment keeps the versions; the next save puts them back at the end', () => {
  const appended = `${NOTE}## Follow-ups\n\n[^1]: a footnote\n`;
  const { doc, envelope } = parseNote(appended);
  assert.equal(doc.snapshots.length, 1, 'the versions are still read');
  assert.ok(doc.text.endsWith('## Follow-ups\n\n[^1]: a footnote\n'), 'the text after them is notes');
  assert.equal(serializeNote(doc, envelope), appended, 'opening never writes');
  const saved = serializeNote({ ...doc, text: doc.text.replace('db store', 'db store x2') }, envelope);
  assert.ok(saved.endsWith('[^1]: a footnote\n\n%% archslate:versions\n{"name":"v1","createdAt":"2026-11-01T14:00:00.000Z","id":"a","text":"service api\\n"}\n%%\n'));
  assert.equal(parseNote(saved).doc.snapshots.length, 1);
  assert.equal((saved.match(/%% archslate:versions/g) ?? []).length, 1, 'one versions comment');
});

test('a block inside another code block or a comment is not the diagram', () => {
  const example = '````markdown\n```archslate\nservice example\n```\n````\n\n';
  const old = '%%\n```archslate\nservice old\n```\n%%\n\n';
  const html = '<!--\n```archslate\nservice hidden\n```\n-->\n\n';
  for (const before of [example, old, html]) {
    const content = NOTE.replace('```archslate', `${before}\`\`\`archslate`);
    const { doc, envelope } = parseNote(content);
    assert.ok(doc.text.startsWith('service api\ndb store'), before);
    assert.equal(serializeNote(doc, envelope), content);
    const saved = serializeNote({ ...doc, text: doc.text.replace('db store', 'db orders') }, envelope);
    assert.ok(saved.includes(before), 'the example is left alone');
    assert.ok(saved.includes('```archslate\nservice api\ndb orders\n'));
  }
  // `%%` in a code span is not a comment.
  const mention = NOTE.replace('```archslate', 'Comments use `%%`.\n\n```archslate');
  assert.ok(parseNote(mention).doc.text.startsWith('service api'));
});

test('a block indented up to three spaces is found, and edits keep its indent', () => {
  const content = 'Intro\n\n  ```archslate\n  service api\n    db store\n\n  api -> store\n  ```\n';
  const { doc, envelope } = parseNote(content);
  assert.equal(doc.text, 'service api\n  db store\n\napi -> store\n');
  assert.equal(serializeNote(doc, envelope), content);
  const saved = serializeNote({ ...doc, text: 'service api\n  db store\n\napi -> store\ncache c\n' }, envelope);
  assert.equal(saved, 'Intro\n\n  ```archslate\n  service api\n    db store\n\n  api -> store\n  cache c\n  ```\n');
  assert.equal(parseNote('    ```archslate\n    service api\n    ```\n').envelope.hasBlock, false, 'four spaces is a code block');
});

test('an empty versions comment does not make an unchanged note look changed', () => {
  const content = '```archslate\nservice api\n```\n\n%% archslate:versions\n%%\n';
  const { doc, envelope } = parseNote(content);
  assert.deepEqual(doc.snapshots, []);
  assert.equal(serializeNote(doc, envelope), content);
});

test('version lines written by hand stay as they are while the versions do not change', () => {
  const content = NOTE.replace('{"name":"v1","createdAt":"2026-11-01T14:00:00.000Z","id":"a","text":"service api\\n"}', '{"id":"a","name":"v1","text":"service api\\n","createdAt":"2026-11-01T14:00:00.000Z"}');
  const { doc, envelope } = parseNote(content);
  const saved = serializeNote({ ...doc, text: doc.text.replace('db store', 'db orders') }, envelope);
  assert.ok(saved.includes('{"id":"a","name":"v1","text":"service api\\n","createdAt":"2026-11-01T14:00:00.000Z"}'));
  const added = serializeNote({ ...doc, snapshots: [...doc.snapshots, { id: 'b', name: 'v2', text: 'x\n', createdAt: '2026-11-02T00:00:00.000Z' }] }, envelope);
  assert.ok(added.includes('{"name":"v1","createdAt":"2026-11-01T14:00:00.000Z","id":"a","text":"service api\\n"}'), 'rewritten once they change');
});

test('a slim envelope keeps what surrounds the block, not copies of the note', () => {
  const { doc, envelope } = parseNote(NOTE);
  const slim = slimEnvelope(envelope);
  assert.equal(slim.original, null);
  assert.equal(slim.versionLines, null);
  const saved = serializeNote({ ...doc, text: doc.text.replace('db store', 'db orders') }, slim);
  assert.ok(saved.startsWith('---\narchslate: diagram\ntags: [system-design]\n---\n\n```archslate\nservice api\ndb orders\n'));
  assert.equal(serializeNote(doc, slim), NOTE, 'the same note, written again');
});
