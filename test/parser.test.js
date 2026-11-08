import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, tokenizeLine } from '../packages/core/parser.js';
import { EXAMPLE_DOCUMENT } from '../apps/web/src/example.js';

test('tokenizer keeps dashes in names but splits arrows', () => {
  const { tokens } = tokenizeLine('order-service->billing.v2');
  assert.deepEqual(
    tokens.map((t) => [t.type, t.value]),
    [
      ['word', 'order-service'],
      ['arrow', '->'],
      ['word', 'billing.v2'],
    ],
  );
});

test('raw labels run to end of line, comments need leading whitespace', () => {
  const { tokens, comment } = tokenizeLine('a -> b: GET http://x/#frag  # note');
  assert.equal(tokens.at(-1).type, 'text');
  assert.equal(tokens.at(-1).value, 'GET http://x/#frag');
  assert.ok(comment);
});

test('quoted strings support escapes', () => {
  const { tokens } = tokenizeLine('service a "say \\"hi\\""');
  assert.equal(tokens[2].value, 'say "hi"');
});

test('parses nodes, groups, edges with lines and keys', () => {
  const model = parse(
    [
      'direction down',
      'client web "Web"',
      'group core "Core" {',
      '  service api',
      '  db store "Store"',
      '}',
      'web -> api: HTTPS',
      'api --> store',
      'api --> store',
    ].join('\n'),
  );
  assert.deepEqual(model.errors, []);
  assert.equal(model.direction, 'down');
  assert.deepEqual(
    model.nodes.map((n) => [n.id, n.kind, n.label, n.group, n.line]),
    [
      ['web', 'client', 'Web', null, 1],
      ['api', 'service', 'api', 'core', 3],
      ['store', 'db', 'Store', 'core', 4],
    ],
  );
  assert.equal(model.groupById.get('core').endLine, 5);
  assert.deepEqual(
    model.edges.map((e) => [e.key, e.op, e.label]),
    [
      ['web->api', '->', 'HTTPS'],
      ['api-->store', '-->', ''],
      ['api-->store#2', '-->', ''],
    ],
  );
  assert.deepEqual(model.lineIndex.get(6), { type: 'edge', key: 'web->api' });
  assert.deepEqual(model.lineIndex.get(5), { type: 'group', id: 'core' });
});

test('aliases resolve to canonical kinds', () => {
  const model = parse('database d\nconsumer c');
  assert.deepEqual(
    model.nodes.map((n) => n.kind),
    ['db', 'worker'],
  );
});

test('errors are collected per line and the rest still parses', () => {
  const model = parse(
    [
      'service a',
      'servce b',
      'service a',
      'a -> ghost',
      'a -> b -> c',
      'service c "unterminated',
      '}',
      'group g "G" {',
      'a -> g',
    ].join('\n'),
  );
  const byLine = model.errors.map((e) => e.line);
  assert.deepEqual(byLine, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.match(model.errors[0].message, /Unknown type "servce"/);
  assert.match(model.errors[1].message, /already declared/);
  assert.match(model.errors[2].message, /Unknown component "ghost"/);
  assert.match(model.errors[3].message, /One link per line/);
  assert.match(model.errors[4].message, /Missing closing quote/);
  assert.equal(model.nodes.length, 2, 'a and the unterminated c still parse');
  assert.equal(model.edges.length, 0);
});

test('groups without an explicit id derive one from the title', () => {
  const model = parse('group "Read Side" {\n}\ngroup "Read Side" {\n}');
  assert.deepEqual(
    model.groups.map((g) => g.id),
    ['read_side', 'read_side_2'],
  );
});

test('example document parses cleanly in every version', () => {
  for (const text of [EXAMPLE_DOCUMENT.text, ...EXAMPLE_DOCUMENT.snapshots.map((s) => s.text)]) {
    assert.deepEqual(parse(text).errors, []);
  }
});
