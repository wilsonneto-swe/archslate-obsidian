import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, tokenizeLine, flowAtLine } from '../packages/core/parser.js';
import * as edits from '../packages/core/edits.js';
import { unionModel, isEmptySummary } from '../packages/core/diff.js';
import { flowView } from '../packages/core/flows.js';
import { layoutDiagram } from '../packages/core/layout.js';

const clean = (text) => {
  const model = parse(text);
  assert.deepEqual(model.errors, [], text);
  return model;
};

const DOC = `direction down

client web "Web"
service api "API" x3 [stateless, autoscaled]
note api "Validates and rate limits per user"
db store "Store" [Postgres, sharded by user_id]

web -> api: POST /orders [10k QPS]
api --> store
web <-> api: WebSocket

flow place "Place order" {
  web -> api: submit
  api --> store: persist
  api -> web: push status
}

---

## Why

Writes go through **one** service.`;

// ------------------------------------------------------------------ parser

test('arrows: "-->" is an event, "=>" still reads as one, "<->" is a connection', () => {
  const ops = (line) => tokenizeLine(line).tokens.filter((t) => t.type === 'arrow').map((t) => t.value);
  assert.deepEqual(ops('a --> b'), ['-->']);
  assert.deepEqual(ops('a-->b'), ['-->']);
  assert.deepEqual(ops('a => b'), ['-->']);
  assert.deepEqual(ops('a <-> b'), ['<->']);
  assert.deepEqual(ops('order-service->b'), ['->']);
  const model = clean('service a\nservice b\na => b\na <-> b');
  assert.deepEqual(model.edges.map((e) => e.key), ['a-->b', 'a<->b']);
});

test('instance counts, details and labels in any order', () => {
  const model = clean(DOC);
  const api = model.nodeById.get('api');
  assert.equal(api.count, 3);
  assert.deepEqual(api.props, ['stateless', 'autoscaled']);
  assert.deepEqual(model.nodeById.get('store').props, ['Postgres', 'sharded by user_id']);
  assert.equal(clean('worker w xN').nodeById.get('w').count, 'N');
  assert.equal(clean('worker w [a] x2 "W"').nodeById.get('w').label, 'W');
  assert.match(parse('worker w x0').errors[0].message, /x1 or more/);
  assert.match(parse('worker w [a').errors[0].message, /closing "]"/);
});

test('link details: after the label, before the colon, or alone', () => {
  const model = clean('service a\nservice b\na -> b: POST /x [10k QPS, p99 < 50ms]\nb -> a [async]: retry\na --> b: [batch]');
  assert.deepEqual(
    model.edges.map((e) => [e.label, e.props]),
    [
      ['POST /x', ['10k QPS', 'p99 < 50ms']],
      ['retry', ['async']],
      ['', ['batch']],
    ],
  );
});

test('notes attach to components and get stable keys', () => {
  const model = clean(DOC);
  assert.deepEqual(model.notes.map((n) => [n.key, n.target, n.text]), [['note:api:1', 'api', 'Validates and rate limits per user']]);
  assert.deepEqual(model.lineIndex.get(4), { type: 'note', key: 'note:api:1' });
  const bad = parse('group g {\n}\nservice a\nnote g "x"\nnote ghost "x"\nnote a unquoted');
  assert.deepEqual(
    bad.errors.map((e) => e.message.split('.')[0]),
    ['Notes attach to components, not groups', 'Unknown component "ghost"', 'Note text must be quoted, for example: note api "Rate limited per user"'],
  );
});

test('flows walk existing links, connections in both directions', () => {
  const model = clean(DOC);
  const flow = model.flowById.get('place');
  assert.equal(flow.label, 'Place order');
  assert.deepEqual(
    flow.steps.map((s) => [s.edgeKey, s.label, s.reversed]),
    [
      ['web->api', 'submit', false],
      ['api-->store', 'persist', false],
      ['web<->api', 'push status', true],
    ],
  );
  assert.equal(flowAtLine(model, 13).id, 'place');
  assert.equal(flowAtLine(model, 3), null);

  const bad = parse('service a\nservice b\na -> b\nflow f {\n  b -> a\n  a -> ghost\n  service c\n}');
  assert.deepEqual(
    bad.errors.map((e) => [e.line, e.message.split('.')[0]]),
    [
      [4, 'The link goes from a to b, not the other way'],
      [5, 'Unknown component "ghost"'],
      [6, 'Only links go inside a flow, for example: web -> api: sends order'],
    ],
  );
});

test('everything after "---" is markdown and is not parsed', () => {
  const model = clean(DOC);
  assert.equal(model.markdownLine, 17);
  assert.equal(model.diagramEnd, 17);
  assert.equal(model.markdown.trim(), '## Why\n\nWrites go through **one** service.');
  assert.equal(parse('group g {\n---\n}').errors[0].message, 'Group "g" is never closed');
});

// ------------------------------------------------------------------- edits

test('canvas inserts land above the markdown section and flows', () => {
  let { text } = edits.addNode(DOC, { kind: 'cache', label: 'Hot keys' });
  let model = clean(text);
  assert.ok(model.nodeById.get('hot_keys').line < model.flowById.get('place').line);
  assert.ok(model.nodeById.get('hot_keys').line > model.notes[0].line, 'not between a component and its note');
  assert.ok(text.endsWith('Writes go through **one** service.'));

  ({ text } = edits.addNode('---\nnotes', { kind: 'db', label: 'x' }));
  assert.equal(text, 'db x\n\n---\nnotes');
  ({ text } = edits.addEdge('service a\nservice b\n---\nnotes', { from: 'a', to: 'b' }));
  assert.equal(text, 'service a\nservice b\n\na -> b\n\n---\nnotes');
  model = clean(edits.addEdge('service a\nservice b\n\nflow f {\n}', { from: 'a', to: 'b' }).text);
  assert.ok(model.edges[0].line < model.flows[0].line);
});

test('removing a component takes its notes and flow steps with it', () => {
  const model = clean(edits.removeNode(DOC, 'store').text);
  assert.equal(model.flowById.get('place').steps.length, 2);
  assert.equal(clean(edits.removeNode(DOC, 'api').text).notes.length, 0);
  // "web -> api: submit" can still walk the WebSocket connection: it stays.
  const afterEdge = clean(edits.removeEdge(DOC, 'web->api').text);
  assert.deepEqual(afterEdge.flowById.get('place').steps.map((s) => s.edgeKey), ['web<->api', 'api-->store', 'web<->api']);
  const afterBoth = clean(edits.removeEdge(edits.removeEdge(DOC, 'web->api').text, 'web<->api').text);
  assert.deepEqual(afterBoth.flowById.get('place').steps.map((s) => s.edgeKey), ['api-->store']);
});

test('parallel links: removing one keeps the flow steps the other can carry', () => {
  const text = 'service api\ndb store\napi -> store: reads\napi -> store: writes\nflow f "F" {\n  api -> store: persist the order\n}\n';
  const model = clean(edits.removeEdge(text, 'api->store').text);
  assert.equal(model.flows[0].steps.length, 1);
});

test('group ids: a title-only group never takes a name declared later, and renaming keeps its id', () => {
  const model = clean('group "Orders" {\n  service orders\n  db orders_db\n}\nclient web\nweb -> orders\n');
  assert.deepEqual(model.nodes.map((n) => n.id), ['orders', 'orders_db', 'web']);
  assert.equal(model.groups[0].id, 'orders_2');
  assert.equal(model.nodeById.get('orders').group, 'orders_2');
  const text = 'group "Core" {\n  service api\n}\ndb store\napi -> store\n';
  const renamed = edits.setGroupLabel(text, 'core', 'Store');
  assert.equal(renamed.text, 'group core "Store" {\n  service api\n}\ndb store\napi -> store\n');
  assert.equal(clean(renamed.text).groups[0].id, 'core');
  // Moving a component into such a group works (the slot is found before the move).
  const moved = edits.moveNodeToGroup('service payments "Payments API"\ngroup "Payments" {\n  db ledger\n}\n', 'payments', 'payments_2');
  assert.equal(clean(moved.text).nodeById.get('payments').group, 'payments_2');
});

test('names in any script; no-break spaces separate; x1 is a single card', () => {
  const model = clean('service सेवा "Orders"\ndb 𝓈tore\nसेवा\u00a0-> 𝓈tore\nservice one x1\n');
  assert.deepEqual(model.nodes.map((n) => n.id), ['सेवा', '𝓈tore', 'one']);
  assert.equal(model.edges.length, 1);
  assert.equal(model.nodeById.get('one').count, null);
  assert.ok(parse('service api x12345678901234567890\n').errors[0].message.includes('too large'));
  assert.ok(parse('toString api\n').errors[0].message.startsWith('Unknown type'), 'Object.prototype names are not kinds');
});

test('label, details and count edits leave the other tokens alone', () => {
  assert.equal(edits.setNodeLabel('service api x3 [stateless] "Orders API"\n', 'api', '').text, 'service api x3 [stateless]\n');
  const linked = edits.setEdgeProps('client web\nservice api\nweb -> api: GET /orders\n', 'web->api', 'ticket #42').text;
  assert.equal(linked, 'client web\nservice api\nweb -> api [ticket #42]: GET /orders\n');
  const edge = clean(linked).edges[0];
  assert.equal(edge.label, 'GET /orders');
  assert.deepEqual(edge.props, ['ticket #42']);
  assert.equal(edits.setNodeCount('service api\n', 'api', '1234567890123456789012').text, 'service api\n');
  assert.equal(edits.setNodeCount('service api\n', 'api', '007').text, 'service api x7\n');
});

test('reversing or retyping a link keeps flow steps valid', () => {
  let { text } = edits.reverseEdge(DOC, 'api-->store');
  let model = clean(text);
  assert.ok(text.includes('  store --> api: persist'));
  ({ text } = edits.setEdgeOp(DOC, 'web->api', '-->'));
  model = clean(text);
  assert.ok(text.includes('  web --> api: submit'));
  assert.equal(model.flows[0].steps[0].edgeKey, 'web-->api');
});

test('counts and details are added, replaced and removed', () => {
  let { text } = edits.setNodeCount(DOC, 'store', 2);
  assert.ok(text.includes('db store "Store" x2 [Postgres'));
  ({ text } = edits.setNodeCount(text, 'store', 'n'));
  assert.ok(text.includes('db store "Store" xN ['));
  ({ text } = edits.setNodeCount(text, 'store', 1));
  assert.ok(text.includes('db store "Store" [Postgres'));
  ({ text } = edits.setNodeProps(text, 'store', 'MySQL,  read replicas '));
  assert.ok(text.includes('db store "Store" [MySQL, read replicas]'));
  ({ text } = edits.setNodeProps(text, 'store', ''));
  assert.ok(text.includes('db store "Store"\n'));
  ({ text } = edits.setNodeProps(text, 'web', ['edge cached']));
  assert.ok(text.includes('client web "Web" [edge cached]'));
  clean(text);
});

test('link label edits keep the details, and details edits keep the label', () => {
  let { text } = edits.setEdgeLabel(DOC, 'web->api', 'PUT /orders');
  assert.ok(text.includes('web -> api: PUT /orders [10k QPS]'));
  ({ text } = edits.setEdgeLabel(text, 'web->api', ''));
  assert.ok(text.includes('web -> api [10k QPS]\n'));
  ({ text } = edits.setEdgeLabel(text, 'web->api', 'GET'));
  assert.equal(clean(text).edgeByKey.get('web->api').label, 'GET');
  ({ text } = edits.setEdgeProps(text, 'api-->store', '2k writes/s'));
  assert.ok(text.includes('api --> store [2k writes/s]'));
  ({ text } = edits.setEdgeProps(text, 'web->api', []));
  assert.ok(text.includes('web -> api: GET\n'));
  ({ text } = edits.setEdgeLabel(text, 'api-->store', 'odd ]'));
  assert.equal(clean(text).edgeByKey.get('api-->store').label, 'odd ]');
});

test('notes: add under the component, edit, remove, move along', () => {
  let { text, select } = edits.addNote(DOC, 'api', 'Idempotency keys');
  let model = clean(text);
  assert.deepEqual(select, { type: 'note', key: 'note:api:2' });
  assert.equal(model.noteByKey.get('note:api:2').line, 5, 'after the existing note');
  ({ text } = edits.setNoteText(text, 'note:api:2', 'Idempotency "keys"'));
  assert.equal(clean(text).noteByKey.get('note:api:2').text, 'Idempotency "keys"');
  ({ text } = edits.removeNote(text, 'note:api:1'));
  assert.deepEqual(clean(text).notes.map((n) => n.text), ['Idempotency "keys"']);

  text = edits.moveNodeToGroup('group g {\n}\nservice a\nnote a "x"\nservice b', 'a', 'g').text;
  assert.equal(text, 'group g {\n  service a\n  note a "x"\n}\nservice b');
});

test('ensureMarkdown starts a notes section once', () => {
  const first = edits.ensureMarkdown('service a\n');
  assert.equal(first.text, 'service a\n\n---\n\n## Notes\n\n');
  assert.equal(parse(first.text).markdown, '\n## Notes\n\n');
  assert.equal(edits.ensureMarkdown(first.text).text, first.text);
});

// -------------------------------------------------------------- diff, flows

test('diff sees scaling, details, notes and markdown', () => {
  const before = parse('service a x2 [v1]\nnote a "old"\nservice b\na -> b [1k QPS]\n---\nA');
  const after = parse('service a x5 [v1]\nnote a "new"\nservice b [cache]\na -> b [5k QPS]\n---\nB');
  const union = unionModel(before, after);
  assert.equal(union.nodeById.get('a').caption, 'scaled out, was ×2');
  assert.equal(union.nodeById.get('b').caption, 'details added');
  assert.equal(union.edges[0].displayLabel, 'was [1k QPS]');
  assert.deepEqual(union.summary.notes, { added: 0, removed: 0, changed: 1 });
  assert.equal(union.summary.markdownChanged, true);
  assert.ok(!isEmptySummary(union.summary));
  assert.ok(isEmptySummary(unionModel(after, after).summary));
});

test('flow view numbers steps and marks what is outside', () => {
  const view = flowView(clean(DOC), 'place');
  const byKey = Object.fromEntries(view.edges.map((e) => [e.key, e]));
  assert.deepEqual(byKey['web->api'].steps, [1]);
  assert.equal(byKey['web->api'].displayLabel, 'submit');
  assert.deepEqual(byKey['web<->api'].steps, [3]);
  assert.equal(view.nodeById.get('store').flow, 'in');
  const partial = flowView(clean(DOC.replace('  api --> store: persist\n', '')), 'place');
  assert.equal(partial.nodeById.get('store').flow, 'out');
  assert.equal(partial.edgeByKey.get('api-->store').flow, 'out');
});

// ------------------------------------------------------------------ layout

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('notes sit beside their component without overlapping anything', () => {
  for (const direction of ['down', 'right']) {
    const model = clean(DOC.replace('direction down', `direction ${direction}`));
    const layout = layoutDiagram(model);
    const block = layout.notes.get('api');
    assert.ok(block, 'api has a note block');
    const card = layout.nodes.get('api');
    if (direction === 'down') assert.ok(block.x >= card.x + card.w, 'note to the right');
    else assert.ok(block.y >= card.y + card.h, 'note below');
    for (const node of layout.nodes.values()) assert.ok(!overlaps(node, block), `${node.id} overlaps the note`);
    for (const [key, { points }] of layout.edges) {
      for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1];
        const b = points[i];
        const segment = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x) || 0.01, h: Math.abs(a.y - b.y) || 0.01 };
        const inner = { x: block.x + 1, y: block.y + 1, w: block.w - 2, h: block.h - 2 };
        assert.ok(!overlaps(segment, inner), `${key} crosses the note (${direction})`);
      }
    }
  }
});

test('notes stay inside their component group', () => {
  const model = clean('group g "G" {\n  service a\n  note a "a fairly long note that wraps over a couple of lines"\n}\nservice b\nb -> a');
  const layout = layoutDiagram(model);
  const group = layout.groups.get('g');
  const block = layout.notes.get('a');
  assert.ok(block.x >= group.x && block.y >= group.y && block.x + block.w <= group.x + group.w && block.y + block.h <= group.y + group.h);
  assert.ok(block.items[0].lines.length >= 2, 'long notes wrap');
});

test('stacked and detailed cards grow to fit', () => {
  const model = clean('service a\nservice b x3\nservice c [one, two, three, four, five, six, seven, eight, nine, ten, eleven, twelve, thirteen, fourteen, fifteen, sixteen, seventeen, eighteen]');
  const layout = layoutDiagram(model);
  const [a, b, c] = ['a', 'b', 'c'].map((id) => layout.nodes.get(id));
  assert.equal(b.stack, 8);
  assert.ok(b.h === a.h + 8 && b.w >= a.w + 8);
  assert.ok(c.propLines.length > 1 && c.propLines.length <= 3 && c.h > a.h);
  assert.ok(c.propLines.at(-1).endsWith('…'));
});

test('edge labels make room for details and step badges', () => {
  const view = flowView(clean(DOC), 'place');
  const layout = layoutDiagram(view);
  const label = layout.edges.get('web->api').label;
  assert.equal(label.badge, '1');
  assert.equal(label.text, 'submit');
  assert.equal(label.propsText, '10k QPS');
  assert.equal(label.h, 29);
});

test('diff: parallel links pair by label first; flows and direction count as changes', () => {
  const before = parse('service api\ndb store\napi -> store: reads\napi -> store: writes\n');
  const after = parse('service api\ndb store\napi -> store: writes\n');
  const union = unionModel(before, after);
  assert.deepEqual(union.summary.edges, { added: 0, removed: 1, changed: 0 });
  assert.deepEqual(union.edges.map((e) => `${e.label}:${e.status}`), ['writes:same', 'reads:removed']);
  const flowAdded = unionModel(parse('client web\nservice api\nweb -> api\n'), parse('client web\nservice api\nweb -> api\nflow f "F" {\n  web -> api: go\n}\n'));
  assert.equal(flowAdded.summary.flows.added, 1);
  assert.ok(!isEmptySummary(flowAdded.summary));
  const turned = unionModel(parse('service a\n'), parse('direction down\nservice a\n'));
  assert.ok(turned.summary.directionChanged && !isEmptySummary(turned.summary));
});

test('flow steps that walk no link get no number and leave no gap', () => {
  const model = parse('client a\nservice b\ndb c\na -> b\nb -> c\nflow f "F" {\n  a -> b: one\n  a -> zz: typo\n  b -> c: two\n}\n');
  const view = flowView(model, 'f');
  assert.deepEqual(view.edges.map((e) => e.steps), [[1], [2]]);
});

test('top to bottom, a group as wide as its title never covers its neighbour', () => {
  const model = parse('direction down\ngroup a "Payments and settlement platform (EU region)" {\n  service pay\n}\nservice other\n');
  const layout = layoutDiagram(model);
  const group = layout.groups.get('a');
  const other = layout.nodes.get('other');
  const overlaps = other.x < group.x + group.w && group.x < other.x + other.w && other.y < group.y + group.h && group.y < other.y + other.h;
  assert.ok(!overlaps, JSON.stringify({ group, other }));
});
