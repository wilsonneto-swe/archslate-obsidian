import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../tools/archslate-cli/cli.mjs';
import { parseNote } from '../packages/core/document.js';
import { parse } from '../packages/core/parser.js';

const capture = () => {
  const io = { lines: [], errors: [] };
  io.out = (line) => io.lines.push(line);
  io.err = (line) => io.errors.push(line);
  return io;
};

test('every example note opens cleanly', () => {
  const dir = new URL('../examples/', import.meta.url);
  const notes = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md');
  assert.ok(notes.length >= 4);
  for (const name of notes) {
    const { doc, envelope } = parseNote(readFileSync(new URL(name, dir), 'utf8'));
    assert.ok(envelope.hasBlock, `${name} has a diagram block`);
    assert.deepEqual(parse(doc.text).errors, [], name);
  }
});

test('the CLI writes, updates, versions and validates a note', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archslate-cli-'));
  try {
    const note = join(dir, 'd.md');
    const source = join(dir, 's.txt');
    writeFileSync(source, 'service a\nservice b\na -> b\n---\n\n## Notes\n\nkeep me\n');
    let io = capture();
    assert.equal(run(['new', note, '--from', source], io), 0);
    assert.equal(run(['new', note, '--from', source], capture()), 2, 'refuses to overwrite');
    assert.equal(run(['version', note, '--name', 'first'], capture()), 0);
    writeFileSync(source, 'service a\nservice b\ncache c\na -> b\na -> c\n');
    assert.equal(run(['set', note, '--from', source], capture()), 0);
    const { doc } = parseNote(readFileSync(note, 'utf8'));
    assert.ok(doc.text.includes('cache c'));
    assert.ok(doc.text.includes('keep me'), 'set keeps the notes');
    assert.deepEqual(doc.snapshots.map((s) => s.name), ['first']);
    io = capture();
    assert.equal(run(['validate', note], io), 0);
    assert.ok(io.lines.join('\n').includes('- a -> c (request)'));
    writeFileSync(source, 'service a\na -> ghost\n');
    io = capture();
    assert.equal(run(['set', note, '--from', source], io), 1);
    assert.match(io.errors.join('\n'), /line 2: Unknown component "ghost"/);
    assert.ok(readFileSync(note, 'utf8').includes('cache c'), 'nothing written on problems');
    writeFileSync(note, '---\narchslate: diagram\n---\n\n```archslate\nservice a\nsrvice b\n```\n');
    io = capture();
    assert.equal(run(['validate', note], io), 1);
    assert.match(io.errors.join('\n'), /line 7: Unknown type "srvice"/, 'line numbers are the note\'s');
    assert.equal(run(['bogus', note], capture()), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI never erases a diagram or a note by accident', () => {
  const dir = mkdtempSync(join(tmpdir(), 'archslate-cli-'));
  try {
    const note = join(dir, 'd.md');
    const source = join(dir, 's.txt');
    writeFileSync(source, 'service a\nservice b\na -> b\n---\n\nkeep me\n');
    assert.equal(run(['new', note, '--from', source], capture()), 0);
    const before = readFileSync(note, 'utf8');
    for (const bad of ['', '   \n', `---\narchslate: diagram\n---\n\n\`\`\`archslate\nservice a\n\`\`\`\n`]) {
      writeFileSync(source, bad);
      const io = capture();
      assert.equal(run(['set', note, '--from', source], io), 1, JSON.stringify(bad));
      assert.match(io.errors.join('\n'), /nothing was written/);
    }
    assert.equal(readFileSync(note, 'utf8'), before);
    let io = capture();
    assert.equal(run(['new', note, '--from', source, '--force'], io), 2);
    assert.match(io.errors.join('\n'), /no --force/);

    // CRLF and a BOM in the source are taken as plain text.
    writeFileSync(source, '﻿service a\r\nservice b\r\na -> b\r\n');
    assert.equal(run(['set', note, '--from', source], capture()), 0);
    assert.ok(!readFileSync(note, 'utf8').includes('\r'));
    assert.ok(readFileSync(note, 'utf8').includes('keep me'));

    // A source ending in a bare "---" keeps the notes, without adding a rule each time.
    writeFileSync(source, 'service a\nservice b\na -> b\n---\n');
    for (let i = 0; i < 3; i += 1) assert.equal(run(['set', note, '--from', source], capture()), 0);
    const { doc } = parseNote(readFileSync(note, 'utf8'));
    assert.equal(doc.text, 'service a\nservice b\na -> b\n---\n\nkeep me\n');

    // Replacing the notes is said out loud.
    writeFileSync(source, 'service a\n---\nnew notes\n');
    io = capture();
    assert.equal(run(['set', note, '--from', source], io), 0);
    assert.match(io.lines.join('\n'), /notes below the diagram were replaced/);

    // A plain note: validate and version say there is no diagram.
    const plain = join(dir, 'plain.md');
    writeFileSync(plain, '# Just notes\n');
    io = capture();
    assert.equal(run(['validate', plain], io), 1);
    assert.match(io.errors.join('\n'), /no ```archslate block/);
    assert.equal(run(['version', plain, '--name', 'x'], capture()), 2);
    assert.equal(readFileSync(plain, 'utf8'), '# Just notes\n');

    // Terminal escapes in a note are shown, not sent.
    writeFileSync(note, '```archslate\nservice a "\u001b[31mred"\n```\n');
    io = capture();
    run(['validate', note], io);
    assert.ok(!io.lines.join('\n').includes('\u001b'));
    assert.ok(io.lines.join('\n').includes('\\u001b'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
