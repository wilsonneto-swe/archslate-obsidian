import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opensAsDiagram, renamedPath, untitledName } from '../src/auto-open.js';
import { patchMethod } from '../src/patch.js';
import { MAX_NOTES, ViewStateStore } from '../src/view-state.js';

const request = (overrides = {}) => ({ type: 'markdown', path: 'a/Note.md', layoutReady: true, choice: undefined, flagged: true, ...overrides });

test('a flagged note opens as a diagram, unless the user chose Markdown there', () => {
  assert.equal(opensAsDiagram(request()), true);
  assert.equal(opensAsDiagram(request({ choice: 'markdown' })), false);
  assert.equal(opensAsDiagram(request({ choice: 'diagram' })), true);
  assert.equal(opensAsDiagram(request({ flagged: false })), false);
  assert.equal(opensAsDiagram(request({ layoutReady: false })), false, 'restoring the saved layout');
  assert.equal(opensAsDiagram(request({ restoring: true })), false, 'a restored background tab shown for the first time');
  assert.equal(opensAsDiagram(request({ type: 'archslate' })), false);
  assert.equal(opensAsDiagram(request({ path: 'a/Board.canvas' })), false);
  assert.equal(opensAsDiagram(request({ path: null })), false);
});

test('renamed paths follow files and folders', () => {
  assert.equal(renamedPath('a/Note.md', 'a/Note.md', 'b/Note.md'), 'b/Note.md');
  assert.equal(renamedPath('a/x/Note.md', 'a', 'z'), 'z/x/Note.md');
  assert.equal(renamedPath('ab/Note.md', 'a', 'z'), null);
});

test('untitled names count up until one is free', () => {
  const taken = new Set(['Untitled diagram', 'Untitled diagram 1']);
  assert.equal(untitledName((n) => taken.has(n), 'Untitled diagram'), 'Untitled diagram 2');
  assert.equal(untitledName(() => false, 'Untitled diagram'), 'Untitled diagram');
});

test('the view-state store keeps, follows, caps and tolerates', () => {
  const store = new ViewStateStore({ version: 1, notes: { 'x.md': { state: { view: { k: 2, tx: 1, ty: 2 }, sourceHidden: true }, at: 1 }, 'bad.md': { state: 'nope', at: 2 } } });
  assert.deepEqual(store.get('x.md'), { view: { k: 2, tx: 1, ty: 2 }, codeWidth: null, sourceHidden: true, notes: null });
  assert.equal(store.get('bad.md'), null);
  assert.equal(store.set('y.md', { view: null, codeWidth: '30%', notes: false }), true);
  assert.equal(store.set('y.md', { view: null, codeWidth: '30%', notes: false }), false, 'no change, no save');
  assert.equal(store.set('z.md', { codeWidth: 'calc(1px)' }), true);
  assert.equal(store.get('z.md').codeWidth, null, 'only plain widths');
  assert.equal(store.rename('y.md', 'folder/y.md'), true);
  assert.equal(store.get('folder/y.md').codeWidth, '30%');
  assert.equal(store.delete('folder'), true);
  assert.equal(store.get('folder/y.md'), null);
  for (let i = 0; i < MAX_NOTES + 5; i += 1) store.set(`n${i}.md`, { notes: true }, 1000 + i);
  assert.equal(store.notes.size, MAX_NOTES);
  assert.equal(store.get('n0.md'), null, 'the oldest go first');
  assert.deepEqual(new ViewStateStore(store.toJSON()).toJSON(), store.toJSON());
  assert.equal(new ViewStateStore({ version: 99, notes: {} }).notes.size, 0);
  assert.equal(new ViewStateStore('garbage').notes.size, 0);
});

test('patchMethod wraps and unwraps, and stays a pass-through under a later patch', () => {
  const target = { greet(name) { return `hi ${name}`; } };
  const undo = patchMethod(target, 'greet', (original) => function (name) { return `${original.call(this, name)}!`; });
  assert.equal(target.greet('a'), 'hi a!');
  undo();
  assert.equal(target.greet('a'), 'hi a');

  const undoMine = patchMethod(target, 'greet', (original) => function (name) { return `${original.call(this, name)}!`; });
  const theirs = target.greet;
  target.greet = function (name) { return `[${theirs.call(this, name)}]`; };
  undoMine();
  assert.equal(target.greet('a'), '[hi a]', 'the later patch keeps working, ours is gone');
});
