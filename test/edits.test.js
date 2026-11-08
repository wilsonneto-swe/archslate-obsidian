import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../packages/core/parser.js';
import * as edits from '../packages/core/edits.js';

const BASE = `# Shop
direction right

client web "Web"

group core "Core" {
  service api "API"
  db store "Store"  # primary
}

web -> api: HTTPS
api -> store
`;

const clean = (text) => {
  const model = parse(text);
  assert.deepEqual(model.errors, [], text);
  return model;
};

test('addNode at top level lands after the last top-level member', () => {
  const { text, select } = edits.addNode(BASE, { kind: 'cache', label: 'Session Cache' });
  const model = clean(text);
  assert.deepEqual(select, { type: 'node', id: 'session_cache' });
  const node = model.nodeById.get('session_cache');
  assert.equal(node.group, null);
  assert.equal(node.label, 'Session Cache');
  assert.equal(model.lines[node.line - 1], '', 'blank line after the group');
  assert.equal(model.lines[node.line - 2], '}');
});

test('addNode inside a group indents and keeps comments', () => {
  const { text } = edits.addNode(BASE, { kind: 'queue', label: 'jobs', group: 'core' });
  const model = clean(text);
  const node = model.nodeById.get('jobs');
  assert.equal(node.group, 'core');
  assert.equal(model.lines[node.line], '  queue jobs');
  assert.ok(text.includes('db store "Store"  # primary'));
});

test('addNode generates unique ids', () => {
  let text = BASE;
  text = edits.addNode(text, { kind: 'service', label: 'API' }).text;
  const model = clean(text);
  assert.ok(model.nodeById.has('api_2'));
});

test('addNode into an empty document', () => {
  const { text } = edits.addNode('', { kind: 'service', label: 'First' });
  const model = clean(text);
  assert.equal(model.nodes[0].id, 'first');
  const withHeader = edits.addNode('# title\ndirection down', { kind: 'db', label: 'x' }).text;
  assert.equal(withHeader, '# title\ndirection down\n\ndb x');
});

test('addEdge appends after existing links and returns its key', () => {
  const { text, select } = edits.addEdge(BASE, { from: 'web', to: 'store', op: '-->', label: 'sync #2' });
  const model = clean(text);
  assert.deepEqual(select, { type: 'edge', key: 'web-->store' });
  const edge = model.edgeByKey.get('web-->store');
  assert.equal(edge.label, 'sync #2');
  assert.equal(edge.line, model.edgeByKey.get('api->store').line + 1);
});

test('addEdge with no existing links separates with a blank line', () => {
  const { text, select } = edits.addEdge('service a\nservice b\n\n', { from: 'a', to: 'b' });
  assert.equal(text, 'service a\nservice b\n\na -> b\n\n');
  assert.deepEqual(select, { type: 'edge', key: 'a->b' });
});

test('removeNode removes its links too', () => {
  const { text } = edits.removeNode(BASE, 'api');
  const model = clean(text);
  assert.equal(model.nodes.length, 2);
  assert.equal(model.edges.length, 0);
  assert.ok(!text.includes('\n\n\n'), 'no double blank lines left behind');
});

test('labels: set, replace, clear', () => {
  let text = edits.setNodeLabel(BASE, 'web', 'Browser "SPA"').text;
  assert.equal(clean(text).nodeById.get('web').label, 'Browser "SPA"');
  text = edits.setNodeLabel(text, 'web', '').text;
  assert.ok(text.includes('client web\n'));
  text = edits.setNodeLabel(text, 'web', 'Web').text;
  assert.ok(text.includes('client web "Web"'));
});

test('edge edits: label, op, reverse', () => {
  let { text, select } = edits.setEdgeLabel(BASE, 'api->store', 'INSERT');
  assert.ok(text.includes('api -> store: INSERT'));
  ({ text, select } = edits.setEdgeOp(text, select.key, '-->'));
  assert.ok(text.includes('api --> store: INSERT'));
  assert.deepEqual(select, { type: 'edge', key: 'api-->store' });
  ({ text, select } = edits.reverseEdge(text, select.key));
  assert.ok(text.includes('store --> api: INSERT'));
  ({ text } = edits.setEdgeLabel(text, select.key, ''));
  assert.ok(text.includes('store --> api\n'));
  clean(text);
});

test('setNodeKind swaps the type token only', () => {
  const { text } = edits.setNodeKind(BASE, 'store', 'cache');
  assert.ok(text.includes('  cache store "Store"  # primary'));
});

test('moveNodeToGroup re-indents and relocates', () => {
  let { text } = edits.moveNodeToGroup(BASE, 'web', 'core');
  let model = clean(text);
  assert.equal(model.nodeById.get('web').group, 'core');
  assert.ok(text.includes('  client web "Web"'));
  ({ text } = edits.moveNodeToGroup(text, 'store', null));
  model = clean(text);
  assert.equal(model.nodeById.get('store').group, null);
  assert.ok(text.includes('\ndb store "Store"  # primary'));
});

test('addGroup and ungroup round trip', () => {
  let { text, select } = edits.addGroup(BASE, { label: 'Async' });
  assert.deepEqual(select, { type: 'group', id: 'async' });
  text = edits.addNode(text, { kind: 'queue', label: 'jobs', group: 'async' }).text;
  let model = clean(text);
  assert.equal(model.nodeById.get('jobs').group, 'async');
  text = edits.ungroup(text, 'core').text;
  model = clean(text);
  assert.equal(model.nodeById.get('api').group, null);
  assert.ok(text.includes('\nservice api "API"'));
});

test('setDirection replaces or inserts the directive', () => {
  assert.ok(edits.setDirection(BASE, 'down').text.includes('direction down'));
  const inserted = edits.setDirection('# t\nservice a', 'down').text;
  assert.equal(inserted, '# t\ndirection down\n\nservice a');
});
