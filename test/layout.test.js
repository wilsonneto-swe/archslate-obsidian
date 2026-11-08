import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../packages/core/parser.js';
import { unionModel } from '../packages/core/diff.js';
import { assignLayers, layoutDiagram } from '../packages/core/layout.js';
import { EXAMPLE_DOCUMENT } from '../apps/web/src/example.js';

const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const contains = (outer, inner) => {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  );
};

// True when the open segment a-b passes through the interior of rect r.
function segmentHitsRect(a, b, r) {
  if (a.y === b.y) {
    const [x1, x2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
    return a.y > r.y && a.y < r.y + r.h && x2 > r.x && x1 < r.x + r.w;
  }
  const [y1, y2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return a.x > r.x && a.x < r.x + r.w && y2 > r.y && y1 < r.y + r.h;
}

function checkInvariants(model, layout) {
  const nodes = [...layout.nodes.values()];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      assert.ok(!overlaps(nodes[i], nodes[j]), `nodes ${nodes[i].id} and ${nodes[j].id} overlap`);
    }
  }

  const ancestors = (groupId) => {
    const out = new Set();
    for (let g = groupId; g; g = model.groupById.get(g).parent) out.add(g);
    return out;
  };
  for (const node of model.nodes) {
    const rect = layout.nodes.get(node.id);
    for (const group of model.groups) {
      const box = layout.groups.get(group.id);
      if (ancestors(node.group).has(group.id)) {
        assert.ok(contains(box, rect), `${node.id} escapes group ${group.id}`);
      } else {
        assert.ok(!overlaps(box, rect), `${node.id} intrudes into group ${group.id}`);
      }
    }
  }
  for (const a of model.groups) {
    for (const b of model.groups) {
      if (a === b || ancestors(a.id).has(b.id) || ancestors(b.id).has(a.id)) continue;
      assert.ok(!overlaps(layout.groups.get(a.id), layout.groups.get(b.id)), `groups ${a.id}/${b.id} overlap`);
    }
  }

  for (const edge of model.edges) {
    const { points } = layout.edges.get(edge.key);
    assert.ok(points.length >= 2, `${edge.key} has a route`);
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      assert.ok(a.x === b.x || a.y === b.y, `${edge.key} has a diagonal segment`);
      for (const node of nodes) {
        assert.ok(!segmentHitsRect(a, b, node), `${edge.key} passes through ${node.id}`);
      }
    }
  }
}

test('layers flow forward and pull sources next to their targets', () => {
  const model = parse(`client c\nservice a\nservice b\ndb d\nc -> b\na -> b\nb -> d\nservice x\nx -> a`);
  const layers = assignLayers(model);
  assert.equal(layers.get('x'), 0);
  assert.equal(layers.get('a'), 1);
  assert.equal(layers.get('c'), 1, 'c is pulled right next to b');
  assert.equal(layers.get('b'), 2);
  assert.equal(layers.get('d'), 3);
});

test('cycles do not break layering', () => {
  const model = parse('service a\nservice b\nservice c\na -> b\nb -> c\nc -> a');
  const layers = assignLayers(model);
  assert.deepEqual([...layers.values()].sort(), [0, 1, 2]);
});

test('a simple chain is laid out straight', () => {
  const model = parse('client a\nservice b\ndb c\na -> b\nb -> c');
  const layout = layoutDiagram(model);
  const ys = model.nodes.map((n) => layout.nodes.get(n.id).y);
  assert.equal(new Set(ys).size, 1);
  for (const edge of model.edges) {
    assert.equal(layout.edges.get(edge.key).points.length, 2, `${edge.key} is a straight line`);
  }
});

test('example versions satisfy layout invariants in both directions', () => {
  const texts = [EXAMPLE_DOCUMENT.text, ...EXAMPLE_DOCUMENT.snapshots.map((s) => s.text)];
  for (const text of texts) {
    for (const direction of ['right', 'down']) {
      const model = parse(text.replace(/direction \w+/, `direction ${direction}`));
      checkInvariants(model, layoutDiagram(model));
    }
  }
});

test('diff union lays out without overlaps', () => {
  const [v1] = EXAMPLE_DOCUMENT.snapshots;
  const union = unionModel(parse(v1.text), parse(EXAMPLE_DOCUMENT.text));
  checkInvariants(union, layoutDiagram(union));
});

test('self loops, empty groups and isolated nodes', () => {
  const model = parse('group g "Empty" {\n}\nservice a\na -> a: retry\nservice lonely');
  const layout = layoutDiagram(model);
  assert.ok(layout.groups.get('g').w > 0);
  assert.ok(layout.edges.get('a->a').points.length >= 4);
  checkInvariants(model, layout);
});

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomDiagram(random, size) {
  const kinds = ['service', 'db', 'queue', 'topic', 'cache', 'worker', 'client'];
  const lines = [random() < 0.5 ? 'direction right' : 'direction down'];
  const ids = [];
  let open = 0;
  for (let i = 0; i < size; i += 1) {
    if (random() < 0.12) {
      lines.push(`${'  '.repeat(open)}group g${i} "Group ${i}" {`);
      open += 1;
    }
    const id = `n${i}`;
    ids.push(id);
    const label = random() < 0.3 ? ` "A much longer label ${i}"` : '';
    lines.push(`${'  '.repeat(open)}${kinds[Math.floor(random() * kinds.length)]} ${id}${label}`);
    if (open > 0 && random() < 0.25) {
      open -= 1;
      lines.push(`${'  '.repeat(open)}}`);
    }
  }
  while (open > 0) {
    open -= 1;
    lines.push(`${'  '.repeat(open)}}`);
  }
  const edgeCount = Math.floor(size * (1 + random()));
  for (let i = 0; i < edgeCount; i += 1) {
    const a = ids[Math.floor(random() * ids.length)];
    const b = ids[Math.floor(random() * ids.length)];
    const label = random() < 0.3 ? ': label' : '';
    lines.push(`${a} ${random() < 0.5 ? '->' : '=>'} ${b}${label}`);
  }
  return lines.join('\n');
}

test('random diagrams satisfy layout invariants', () => {
  const random = mulberry32(42);
  for (let i = 0; i < 60; i += 1) {
    const text = randomDiagram(random, 3 + Math.floor(random() * 18));
    const model = parse(text);
    assert.deepEqual(model.errors, [], text);
    try {
      checkInvariants(model, layoutDiagram(model));
    } catch (error) {
      error.message += `\n--- diagram ---\n${text}`;
      throw error;
    }
  }
});

test('layout of a 60 node diagram stays interactive', () => {
  const random = mulberry32(7);
  const model = parse(randomDiagram(random, 60));
  const started = performance.now();
  layoutDiagram(model);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1500, `took ${elapsed.toFixed(0)}ms`);
});
