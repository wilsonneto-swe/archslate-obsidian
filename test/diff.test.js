import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../packages/core/parser.js';
import { unionModel, isEmptySummary } from '../packages/core/diff.js';

const BEFORE = parse(`service a "A"
service b
db old
a -> b: call
a -> old
`);

const AFTER = parse(`service a "Alpha"
service b
queue q
a --> b: call
a --> q
`);

test('statuses for nodes and edges', () => {
  const union = unionModel(BEFORE, AFTER);
  const status = (id) => union.nodeById.get(id).status;
  assert.equal(status('a'), 'changed');
  assert.equal(union.nodeById.get('a').caption, 'was "A"');
  assert.equal(status('b'), 'same');
  assert.equal(status('q'), 'added');
  assert.equal(status('old'), 'removed');

  const edges = Object.fromEntries(union.edges.map((e) => [e.key, e]));
  assert.equal(edges['a-->b'].status, 'changed');
  assert.equal(edges['a-->b'].displayLabel, 'call (was request)');
  assert.equal(edges['a-->q'].status, 'added');
  assert.equal(edges['~a->old'].status, 'removed');

  assert.deepEqual(union.summary.nodes, { added: 1, removed: 1, changed: 1 });
  assert.deepEqual(union.summary.edges, { added: 1, removed: 1, changed: 1 });
});

test('parallel edges pair exactly before loosely', () => {
  const before = parse('service a\nservice b\na -> b\na --> b');
  const after = parse('service a\nservice b\na --> b');
  const union = unionModel(before, after);
  const byKey = Object.fromEntries(union.edges.map((e) => [e.key, e.status]));
  assert.deepEqual(byKey, { 'a-->b': 'same', '~a->b': 'removed' });
});

test('identical models produce an empty summary', () => {
  assert.ok(isEmptySummary(unionModel(AFTER, AFTER).summary));
});
