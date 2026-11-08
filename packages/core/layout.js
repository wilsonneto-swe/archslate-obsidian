// Layered layout (a simplified Sugiyama) for graphs with nested groups.
//
// 1. Assign each node to a layer so links flow one way.
// 2. Treat each group as a rigid block and stack blocks within their parent.
//    Blocks only compete for space where their layer spans overlap, so groups
//    can never overlap each other or contain a stranger, by construction.
// 3. Reorder blocks to reduce crossings, then slide them to line up neighbours.
// 4. Route links around everything (routing.js).
//
// Internally "main" is the flow axis and "cross" the stacking axis, which makes
// `direction down` the same algorithm with the axes swapped at the end.

import { KINDS } from './kinds.js';
import { routeEdges, ROUTING_DEFAULTS } from './routing.js';

const DEFAULTS = {
  nodeHeight: 56,
  nodeTextX: 56,
  nodePadRight: 14,
  minNodeWidth: 132,
  maxLabelWidth: 220,
  layerGap: 56,
  nodeGap: 30,
  blockGap: 36,
  groupPad: 16,
  groupTitle: 20,
  emptyGroupMain: 150,
  emptyGroupCross: 44,
  perLinkRoom: 7,
  orderSweeps: 12,
  relaxPasses: 8,
  // Details under the label, and the stacked look of "x3".
  propLineHeight: 14,
  maxPropLines: 3,
  stackOffset: 8,
  // Sticky notes beside their component.
  noteGap: 18,
  noteMaxWidth: 190,
  noteMinWidth: 96,
  notePad: 8,
  noteLineHeight: 15,
  noteSpacing: 6,
  maxNoteLines: 8,
};

const CHAR_WIDTH = {
  label: 7.3,
  caption: 5.4,
  edge: 5.9,
  title: 6.4,
  prop: 5.4,
  note: 5.9,
  count: 6.2,
  edgeProp: 5.3,
  badge: 6,
};

// Used when no real text metrics are available (tests, headless).
export function estimateTextWidth(text, style) {
  return text.length * (CHAR_WIDTH[style] ?? 7);
}

// Whole characters as people see them: an emoji or an accented letter is never
// cut in half (half an emoji is not even valid text for an SVG file).
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const characters = (text) => (segmenter ? Array.from(segmenter.segment(text), (part) => part.segment) : Array.from(text));

// The longest start of `text` that fits with "…" after it, found by halving:
// a long label costs a few measurements, not one per character.
function fitText(text, maxWidth, style, measure) {
  if (measure(text, style) <= maxWidth) return text;
  const chars = characters(text);
  let lo = 1;
  let hi = Math.max(1, chars.length - 1);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${chars.slice(0, mid).join('')}…`, style) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${chars.slice(0, lo).join('')}…`;
}

// Greedy word wrap. Overlong words are cut, and text past `maxLines` ends in "…".
function wrapText(text, maxWidth, style, measure, maxLines) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || measure(candidate, style) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  const fitted = lines.map((line) => fitText(line, maxWidth, style, measure));
  if (fitted.length > maxLines) {
    // At least two lines' worth of text remain, so this always ends in "…".
    const rest = lines.slice(maxLines - 1).join(' ');
    fitted.length = maxLines - 1;
    fitted.push(fitText(rest, maxWidth, style, measure));
  }
  return fitted;
}

// Size of an edge label: an optional step badge, the label, and details on a
// second line.
function labelSize(edge, measure) {
  const text = edge.displayLabel ?? edge.label ?? '';
  const propsText = edge.props?.length ? edge.props.join(' · ') : '';
  const badge = edge.steps?.length ? edge.steps.join(', ') : '';
  if (!text && !propsText && !badge) return null;
  const badgeW = badge ? Math.max(16, Math.ceil(measure(badge, 'badge')) + 9) : 0;
  const body = Math.max(text ? measure(text, 'edge') : 0, propsText ? measure(propsText, 'edgeProp') : 0);
  if (!text && !propsText) return { w: badgeW, h: 16, text, propsText, badge, badgeW };
  const w = Math.ceil(body) + 10 + (badgeW ? badgeW + 2 : 0);
  return { w, h: text && propsText ? 29 : 16, text, propsText, badge, badgeW };
}

function buildAdjacency(model) {
  const successors = new Map(model.nodes.map((n) => [n.id, []]));
  const predecessors = new Map(model.nodes.map((n) => [n.id, []]));

  const outgoing = new Map(model.nodes.map((n) => [n.id, []]));
  const hasIncoming = new Set();
  for (const edge of model.edges) {
    if (edge.from === edge.to) continue;
    outgoing.get(edge.from).push(edge.to);
    hasIncoming.add(edge.to);
  }

  // Depth-first from the sources. An edge closing a cycle is reversed for
  // layering only; it still draws in its real direction.
  const state = new Map();
  const visit = (id) => {
    state.set(id, 1);
    for (const next of outgoing.get(id)) {
      const seen = state.get(next);
      if (seen === 1) {
        successors.get(next).push(id);
        predecessors.get(id).push(next);
      } else {
        successors.get(id).push(next);
        predecessors.get(next).push(id);
        if (!seen) visit(next);
      }
    }
    state.set(id, 2);
  };
  for (const node of model.nodes) {
    if (!hasIncoming.has(node.id) && !state.get(node.id)) visit(node.id);
  }
  for (const node of model.nodes) {
    if (!state.get(node.id)) visit(node.id);
  }
  return { successors, predecessors };
}

export function assignLayers(model) {
  const { successors, predecessors } = buildAdjacency(model);
  const ids = model.nodes.map((n) => n.id);
  const layer = new Map(ids.map((id) => [id, 0]));

  // Longest path from the sources, in topological order.
  const remaining = new Map(ids.map((id) => [id, predecessors.get(id).length]));
  const queue = ids.filter((id) => remaining.get(id) === 0);
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i];
    for (const next of successors.get(id)) {
      layer.set(next, Math.max(layer.get(next), layer.get(id) + 1));
      remaining.set(next, remaining.get(next) - 1);
      if (remaining.get(next) === 0) queue.push(next);
    }
  }

  const slack = (id) => {
    const preds = predecessors.get(id);
    const succs = successors.get(id);
    return [
      preds.length ? Math.max(...preds.map((p) => layer.get(p))) + 1 : -Infinity,
      succs.length ? Math.min(...succs.map((s) => layer.get(s))) - 1 : Infinity,
    ];
  };

  // Use any slack to shorten links. This is what pulls a lone client right next
  // to the thing it calls instead of leaving it at the far left.
  for (let pass = 0; pass < 4; pass += 1) {
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const id = queue[i];
      const neighbours = [...predecessors.get(id), ...successors.get(id)]
        .map((other) => layer.get(other))
        .sort((a, b) => a - b);
      if (neighbours.length === 0) continue;
      const lowMedian = neighbours[(neighbours.length - 1) >> 1];
      const highMedian = neighbours[neighbours.length >> 1];
      const [lo, hi] = slack(id);
      const wanted = Math.min(highMedian, Math.max(lowMedian, layer.get(id)));
      layer.set(id, Math.min(hi, Math.max(lo, wanted)));
    }
  }

  // Then use it to keep groups compact, deepest groups first.
  const descendants = new Map(model.groups.map((g) => [g.id, []]));
  const connected = (id) => predecessors.get(id).length + successors.get(id).length > 0;
  for (const node of model.nodes) {
    if (!connected(node.id)) continue;
    for (let g = node.group; g; g = model.groupById.get(g).parent) descendants.get(g).push(node.id);
  }
  const depth = (g) => (g.parent ? depth(model.groupById.get(g.parent)) + 1 : 0);
  const deepestFirst = [...model.groups].sort((a, b) => depth(b) - depth(a));
  for (let pass = 0; pass < 3; pass += 1) {
    for (const group of deepestFirst) {
      const members = descendants.get(group.id);
      if (members.length < 2) continue;
      const sorted = members.map((id) => layer.get(id)).sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1];
      for (const id of members) {
        const current = layer.get(id);
        const [lo, hi] = slack(id);
        const moved = Math.min(hi, Math.max(lo, median));
        if (Math.abs(moved - median) < Math.abs(current - median)) layer.set(id, moved);
      }
    }
  }

  // Unconnected nodes sit with their group's connected members, or at the start.
  for (const node of model.nodes) {
    if (connected(node.id)) continue;
    let placed = null;
    for (let g = node.group; g && placed === null; g = model.groupById.get(g).parent) {
      const members = descendants.get(g);
      if (members.length) placed = Math.min(...members.map((id) => layer.get(id)));
    }
    layer.set(node.id, placed ?? Infinity);
  }

  // Close numbering gaps.
  const used = [...new Set([...layer.values()].filter(Number.isFinite))].sort((a, b) => a - b);
  const compact = new Map(used.map((value, index) => [value, index]));
  for (const [id, value] of layer) layer.set(id, compact.get(value) ?? 0);
  return layer;
}

function buildTree(model, layers, boxes, cfg, horizontal, measure) {
  const root = { type: 'root', children: [], parent: null };
  const groupUnits = new Map();

  for (const group of model.groups) {
    const titleWidth = measure(group.label, 'title') + 24;
    const titled = cfg.groupPad + cfg.groupTitle;
    groupUnits.set(group.id, {
      type: 'group',
      id: group.id,
      line: group.line,
      children: [],
      parent: null,
      offset: 0,
      size: 0,
      titleWidth,
      // Top to bottom, the title runs across: the box is at least that wide,
      // and its neighbours are placed knowing it.
      minCross: horizontal ? 0 : titleWidth,
      crossPadStart: horizontal ? titled : cfg.groupPad,
      crossPadEnd: cfg.groupPad,
      mainPadStart: horizontal ? cfg.groupPad : titled,
      mainPadEnd: cfg.groupPad,
    });
  }
  for (const group of model.groups) {
    const unit = groupUnits.get(group.id);
    unit.parent = group.parent ? groupUnits.get(group.parent) : root;
    unit.parent.children.push(unit);
  }
  for (const node of model.nodes) {
    const box = boxes.get(node.id);
    const parent = node.group ? groupUnits.get(node.group) : root;
    const layer = layers.get(node.id);
    // A node's unit is its card plus, across the flow, its sticky notes.
    const cardCross = horizontal ? box.h : box.w;
    const cardMain = horizontal ? box.w : box.h;
    const notes = box.notes;
    const notesCross = notes ? (horizontal ? notes.h : notes.w) + cfg.noteGap : 0;
    const notesMain = notes ? (horizontal ? notes.w : notes.h) : 0;
    parent.children.push({
      type: 'node',
      id: node.id,
      line: node.line,
      parent,
      offset: 0,
      layerMin: layer,
      layerMax: layer,
      cardCross,
      cardMain,
      size: cardCross + notesCross,
      mainSize: Math.max(cardMain, notesMain),
      leaves: [node.id],
    });
  }

  const finish = (unit) => {
    unit.children.sort((a, b) => a.line - b.line);
    unit.leaves = [];
    unit.layerMin = Infinity;
    unit.layerMax = -Infinity;
    for (const child of unit.children) {
      if (child.type === 'group') finish(child);
      unit.leaves.push(...child.leaves);
      if (child.leaves.length) {
        unit.layerMin = Math.min(unit.layerMin, child.layerMin);
        unit.layerMax = Math.max(unit.layerMax, child.layerMax);
      }
    }
  };
  finish(root);

  // A group with nothing in it borrows a position from its parent.
  const settleEmpty = (unit, fallback) => {
    if (unit.leaves.length === 0) {
      unit.layerMin = fallback;
      unit.layerMax = fallback;
      unit.empty = true;
    }
    for (const child of unit.children) {
      if (child.type === 'group') settleEmpty(child, unit.layerMin);
    }
  };
  settleEmpty(root, 0);
  return root;
}

function spansOverlap(a, b) {
  return a.layerMin <= b.layerMax && b.layerMin <= a.layerMax;
}

function gapBetween(a, b, cfg) {
  return a.type === 'group' || b.type === 'group' ? cfg.blockGap : cfg.nodeGap;
}

function stackChildren(container, cfg) {
  const { children } = container;
  children.forEach((child, i) => {
    let floor = 0;
    for (let j = 0; j < i; j += 1) {
      const other = children[j];
      if (spansOverlap(other, child)) {
        floor = Math.max(floor, other.offset + other.size + gapBetween(other, child, cfg));
      }
    }
    child.offset = floor;
  });
}

// Slides rigid children toward the neighbours they link to, while keeping the
// stacking order. Each pass ends in a valid arrangement.
function relaxChildren(container, edges, cfg) {
  const { children } = container;
  if (children.length < 2) return;

  const owner = new Map();
  for (const child of children) {
    for (const leaf of child.leaves) owner.set(leaf, child);
  }
  const links = new Map(children.map((child) => [child, []]));
  for (const edge of edges) {
    const a = owner.get(edge.from);
    const b = owner.get(edge.to);
    if (!a || !b || a === b) continue;
    links.get(a).push({ own: edge.from, other: b, otherLeaf: edge.to });
    links.get(b).push({ own: edge.to, other: a, otherLeaf: edge.from });
  }

  const desiredOffset = (child) => {
    const list = links.get(child);
    if (list.length === 0) return null;
    let sum = 0;
    for (const { own, other, otherLeaf } of list) {
      sum += other.offset + other.centers.get(otherLeaf) - child.centers.get(own);
    }
    return sum / list.length;
  };

  for (let pass = 0; pass < cfg.relaxPasses; pass += 1) {
    children.forEach((child, i) => {
      let floor = -Infinity;
      for (let j = 0; j < i; j += 1) {
        const other = children[j];
        if (spansOverlap(other, child)) {
          floor = Math.max(floor, other.offset + other.size + gapBetween(other, child, cfg));
        }
      }
      const wanted = desiredOffset(child) ?? child.offset;
      child.offset = Math.max(wanted, floor);
    });
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      let ceiling = Infinity;
      for (let j = i + 1; j < children.length; j += 1) {
        const other = children[j];
        if (spansOverlap(other, child)) {
          ceiling = Math.min(ceiling, other.offset - gapBetween(other, child, cfg) - child.size);
        }
      }
      const wanted = desiredOffset(child) ?? child.offset;
      child.offset = Math.min(wanted, ceiling);
    }
  }
}

// Bottom-up: settles each group's interior, leaving it a rigid block with a known
// size and known leaf positions for the level above to align against.
function arrange(unit, edges, cfg, relax) {
  if (unit.type === 'node') {
    unit.centers = new Map([[unit.id, unit.cardCross / 2]]);
    return;
  }
  for (const child of unit.children) arrange(child, edges, cfg, relax);
  stackChildren(unit, cfg);
  if (relax) relaxChildren(unit, edges, cfg);

  let min = Infinity;
  let max = -Infinity;
  for (const child of unit.children) {
    min = Math.min(min, child.offset);
    max = Math.max(max, child.offset + child.size);
  }
  if (unit.children.length === 0) {
    min = 0;
    max = cfg.emptyGroupCross;
  }
  for (const child of unit.children) child.offset -= min;

  const start = unit.crossPadStart ?? 0;
  const end = unit.crossPadEnd ?? 0;
  unit.size = Math.max(start + (max - min) + end, unit.minCross ?? 0);
  unit.centers = new Map();
  for (const child of unit.children) {
    for (const [leaf, center] of child.centers) {
      unit.centers.set(leaf, start + child.offset + center);
    }
  }
}

function placeCross(unit, base, out) {
  unit.crossStart = base;
  if (unit.type === 'node') {
    out.set(unit.id, base + unit.cardCross / 2);
    return;
  }
  const inner = base + (unit.crossPadStart ?? 0);
  for (const child of unit.children) placeCross(child, inner + child.offset, out);
}

function allContainers(root) {
  const out = [root];
  for (let i = 0; i < out.length; i += 1) {
    for (const child of out[i].children) {
      if (child.type === 'group') out.push(child);
    }
  }
  return out;
}

function segmentsCross(a1, a2, b1, b2) {
  const side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = side(b1, b2, a1);
  const d2 = side(b1, b2, a2);
  const d3 = side(a1, a2, b1);
  const d4 = side(a1, a2, b2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function scoreOrder(edges, layers, centers, leafUnits) {
  const segments = edges
    .filter((e) => e.from !== e.to)
    .map((e) => [
      [layers.get(e.from), centers.get(e.from)],
      [layers.get(e.to), centers.get(e.to)],
    ]);

  let score = 0;
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      if (segmentsCross(segments[i][0], segments[i][1], segments[j][0], segments[j][1])) {
        score += 10;
      }
    }
    // A straight line through a node means a detour after routing.
    const [[l1, c1], [l2, c2]] = segments[i];
    const lo = Math.min(l1, l2);
    const hi = Math.max(l1, l2);
    for (const unit of leafUnits) {
      const layer = unit.layerMin;
      if (layer <= lo || layer >= hi) continue;
      const at = c1 + ((c2 - c1) * (layer - l1)) / (l2 - l1);
      if (at > unit.crossStart && at < unit.crossStart + unit.size) score += 6;
    }
    score += Math.abs(c1 - c2) * 0.005;
  }
  return score;
}

function reorderByBarycenter(containers, edges, layers, centers, mode) {
  const neighbours = new Map();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    if (!neighbours.has(edge.from)) neighbours.set(edge.from, []);
    if (!neighbours.has(edge.to)) neighbours.set(edge.to, []);
    neighbours.get(edge.from).push(edge.to);
    neighbours.get(edge.to).push(edge.from);
  }

  for (const container of containers) {
    const weight = new Map();
    for (const child of container.children) {
      const own = new Set(child.leaves);
      let sum = 0;
      let count = 0;
      let selfSum = 0;
      for (const leaf of child.leaves) {
        selfSum += centers.get(leaf);
        for (const other of neighbours.get(leaf) ?? []) {
          if (own.has(other)) continue;
          const earlier = layers.get(other) < layers.get(leaf);
          if ((mode === 'pred' && !earlier) || (mode === 'succ' && earlier)) continue;
          sum += centers.get(other);
          count += 1;
        }
      }
      const fallback = child.leaves.length ? selfSum / child.leaves.length : child.crossStart;
      weight.set(child, count ? sum / count : fallback);
    }
    const indexed = container.children.map((child, index) => ({ child, index }));
    indexed.sort((a, b) => weight.get(a.child) - weight.get(b.child) || a.index - b.index);
    container.children = indexed.map((item) => item.child);
  }
}

function optimizeOrder(root, edges, layers, cfg) {
  const containers = allContainers(root);
  const leafUnits = [];
  for (const container of containers) {
    for (const child of container.children) {
      if (child.type === 'node') leafUnits.push(child);
    }
  }

  const modes = ['pred', 'succ', 'both'];
  let best = null;
  let bestScore = Infinity;
  for (let sweep = 0; sweep < cfg.orderSweeps; sweep += 1) {
    const centers = new Map();
    arrange(root, edges, cfg, false);
    placeCross(root, 0, centers);
    const score = scoreOrder(edges, layers, centers, leafUnits);
    if (score < bestScore) {
      bestScore = score;
      best = containers.map((container) => [...container.children]);
    }
    reorderByBarycenter(containers, edges, layers, centers, modes[sweep % modes.length]);
  }
  containers.forEach((container, i) => {
    container.children = best[i];
  });
}

function computeLayerPositions(root, model, layers, boxes, cfg, horizontal, measure) {
  const layerCount = Math.max(root.layerMax, 0) + 1;
  const size = new Array(layerCount).fill(0);
  const open = new Array(layerCount).fill(0);
  const close = new Array(layerCount).fill(0);

  const walk = (unit) => {
    if (unit.type === 'group' && unit.empty) {
      const layer = unit.layerMin;
      size[layer] = Math.max(size[layer], horizontal ? cfg.emptyGroupMain : cfg.emptyGroupCross);
    }
    if (unit.type === 'node' || (unit.type === 'group' && unit.empty)) {
      const layer = unit.layerMin;
      if (unit.type === 'node') size[layer] = Math.max(size[layer], unit.mainSize);
      let opening = 0;
      let closing = 0;
      const first = unit.type === 'group' ? unit : unit.parent;
      for (let g = first; g && g.type === 'group'; g = g.parent) {
        if (g.layerMin === layer) opening += g.mainPadStart;
        if (g.layerMax === layer) closing += g.mainPadEnd;
      }
      open[layer] = Math.max(open[layer], opening);
      close[layer] = Math.max(close[layer], closing);
    }
    if (unit.type === 'group' && horizontal && unit.layerMin === unit.layerMax) {
      size[unit.layerMin] = Math.max(size[unit.layerMin], unit.titleWidth - 2 * cfg.groupPad);
    }
    for (const child of unit.children ?? []) walk(child);
  };
  walk(root);

  const linksThroughGap = new Array(layerCount).fill(0);
  const labelRoom = new Array(layerCount).fill(0);
  for (const edge of model.edges) {
    if (edge.from === edge.to) continue;
    const a = layers.get(edge.from);
    const b = layers.get(edge.to);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let gap = lo; gap < hi; gap += 1) linksThroughGap[gap] += 1;
    const label = labelSize(edge, measure);
    if (horizontal && label && hi - lo === 1) {
      const room = label.w + 2 * ROUTING_DEFAULTS.stub + 12;
      labelRoom[lo] = Math.max(labelRoom[lo], room);
    }
  }

  const starts = new Array(layerCount).fill(0);
  for (let layer = 1; layer < layerCount; layer += 1) {
    const channel = Math.max(
      cfg.layerGap + Math.max(0, linksThroughGap[layer - 1] - 1) * cfg.perLinkRoom,
      labelRoom[layer - 1],
    );
    starts[layer] = starts[layer - 1] + size[layer - 1] + close[layer - 1] + channel + open[layer];
  }
  return { starts, size };
}

function placeLabels(routes, model, rects, measure) {
  const boxes = new Map();
  const taken = [...rects.values()].map((r) => ({ x: r.x - 3, y: r.y - 3, w: r.w + 6, h: r.h + 6 }));
  const hits = (box) => {
    return taken.some((r) => {
      return box.x < r.x + r.w && box.x + box.w > r.x && box.y < r.y + r.h && box.y + box.h > r.y;
    });
  };

  for (const edge of model.edges) {
    const size = labelSize(edge, measure);
    const points = routes.get(edge.key);
    if (!size || !points) continue;
    const { w, h } = size;

    const segments = [];
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      const horizontal = a.y === b.y;
      const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      const roomy = horizontal && length >= w + 6;
      // Prefer horizontal runs the text actually fits on, longest first.
      segments.push({ a, b, rank: (roomy ? 0 : horizontal ? 2 : 1) * 1e5 - length });
    }
    segments.sort((p, q) => p.rank - q.rank);

    let chosen = null;
    search: for (const { a, b } of segments) {
      for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) {
        const cx = a.x + (b.x - a.x) * t;
        const cy = a.y + (b.y - a.y) * t;
        const box = { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
        chosen ??= box;
        if (!hits(box)) {
          chosen = box;
          break search;
        }
      }
    }
    taken.push(chosen);
    boxes.set(edge.key, { ...size, ...chosen });
  }
  return boxes;
}

// Note text wrapped into a column of stickies, one per note.
function noteBlock(notes, cfg, measure) {
  let width = 0;
  const items = notes.map((note) => {
    const lines = wrapText(note.text, cfg.noteMaxWidth, 'note', measure, cfg.maxNoteLines);
    for (const line of lines) width = Math.max(width, measure(line, 'note'));
    return { note, lines };
  });
  const w = Math.max(cfg.noteMinWidth, Math.ceil(width) + 2 * cfg.notePad);
  let y = 0;
  for (const item of items) {
    item.y = y;
    item.h = item.lines.length * cfg.noteLineHeight + 2 * cfg.notePad - 3;
    y += item.h + cfg.noteSpacing;
  }
  return { w, h: y - cfg.noteSpacing, items };
}

export function layoutDiagram(model, options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const measure = cfg.measureText ?? estimateTextWidth;
  const horizontal = model.direction !== 'down';

  const notesByTarget = new Map();
  for (const note of model.notes ?? []) {
    if (!model.nodeById.has(note.target)) continue;
    if (!notesByTarget.has(note.target)) notesByTarget.set(note.target, []);
    notesByTarget.get(note.target).push(note);
  }

  const boxes = new Map();
  for (const node of model.nodes) {
    const caption = node.caption ?? KINDS[node.kind]?.label ?? node.kind;
    const countText = node.count ? `×${node.count}` : null;
    const countWidth = countText ? Math.ceil(measure(countText, 'count')) + 12 : 0;
    const labelRoom = countWidth ? countWidth + 6 : 0;
    const labelText = fitText(node.label, cfg.maxLabelWidth - labelRoom, 'label', measure);
    const captionText = fitText(caption, cfg.maxLabelWidth, 'caption', measure);
    const propLines = wrapText((node.props ?? []).join(' · '), cfg.maxLabelWidth, 'prop', measure, cfg.maxPropLines);
    const textWidth = Math.max(
      measure(labelText, 'label') + labelRoom,
      measure(captionText, 'caption'),
      ...propLines.map((line) => measure(line, 'prop')),
    );
    const stack = node.count ? cfg.stackOffset : 0;
    const cardW = Math.max(cfg.minNodeWidth, Math.ceil(cfg.nodeTextX + textWidth + cfg.nodePadRight));
    const cardH = cfg.nodeHeight + (propLines.length ? propLines.length * cfg.propLineHeight - 1 : 0);
    const notes = notesByTarget.has(node.id) ? noteBlock(notesByTarget.get(node.id), cfg, measure) : null;
    boxes.set(node.id, {
      w: cardW + stack,
      h: cardH + stack,
      labelText,
      captionText,
      propLines,
      countText,
      countWidth,
      stack,
      notes,
    });
  }

  const layers = assignLayers(model);
  const root = buildTree(model, layers, boxes, cfg, horizontal, measure);
  optimizeOrder(root, model.edges, layers, cfg);
  arrange(root, model.edges, cfg, true);

  const crossCenters = new Map();
  placeCross(root, 0, crossCenters);
  const { starts, size } = computeLayerPositions(root, model, layers, boxes, cfg, horizontal, measure);

  const toRect = (mainStart, crossStart, mainSize, crossSize) => {
    return horizontal
      ? { x: Math.round(mainStart), y: Math.round(crossStart), w: mainSize, h: crossSize }
      : { x: Math.round(crossStart), y: Math.round(mainStart), w: crossSize, h: mainSize };
  };

  const nodes = new Map();
  const rects = new Map();
  const groups = new Map();
  const notes = new Map();
  const ancestors = new Map();

  const placeNotes = (id, block, card, slot, unit) => {
    const main = horizontal ? block.w : block.h;
    const cross = horizontal ? block.h : block.w;
    const rect = toRect(slot + (unit.mainSize - main) / 2, unit.crossStart + unit.cardCross + cfg.noteGap, main, cross);
    // A short dotted tie from the card to the first sticky.
    const first = block.items[0];
    const tie = horizontal
      ? (() => {
          const x = Math.min(Math.max(card.x + card.w / 2, rect.x + 10), rect.x + rect.w - 10);
          return [{ x, y: card.y + card.h }, { x, y: rect.y }];
        })()
      : (() => {
          const y = Math.min(Math.max(card.y + card.h / 2, rect.y + 10), rect.y + first.h - 6);
          return [{ x: card.x + card.w, y }, { x: rect.x, y }];
        })();
    notes.set(id, {
      target: id,
      ...rect,
      tie,
      items: block.items.map((item) => ({
        key: item.note.key,
        line: item.note.line,
        status: item.note.status,
        flow: item.note.flow,
        lines: item.lines,
        x: rect.x,
        y: rect.y + item.y,
        w: rect.w,
        h: item.h,
      })),
    });
    // Notes are obstacles for links, like components.
    rects.set(`\u0000note:${id}`, rect);
  };

  const placeRects = (unit, chain, depth) => {
    if (unit.type === 'node') {
      const box = boxes.get(unit.id);
      const layer = unit.layerMin;
      const slot = starts[layer] + (size[layer] - unit.mainSize) / 2;
      const main = slot + (unit.mainSize - unit.cardMain) / 2;
      const rect = toRect(main, unit.crossStart, unit.cardMain, unit.cardCross);
      rects.set(unit.id, rect);
      nodes.set(unit.id, { id: unit.id, ...box, ...rect });
      ancestors.set(unit.id, chain);
      if (box.notes) placeNotes(unit.id, box.notes, rect, slot, unit);
      unit.mainMin = slot;
      unit.mainMax = slot + unit.mainSize;
      return;
    }

    const nextChain = unit.type === 'group' ? [...chain, unit.id] : chain;
    let min = Infinity;
    let max = -Infinity;
    for (const child of unit.children) {
      placeRects(child, nextChain, depth + (unit.type === 'group' ? 1 : 0));
      min = Math.min(min, child.mainMin);
      max = Math.max(max, child.mainMax);
    }
    if (unit.type !== 'group') return;

    if (unit.children.length === 0) {
      min = starts[unit.layerMin];
      max = min + (horizontal ? cfg.emptyGroupMain : cfg.emptyGroupCross);
    }
    unit.mainMin = min - unit.mainPadStart;
    unit.mainMax = max + unit.mainPadEnd;

    let mainSize = unit.mainMax - unit.mainMin;
    let crossSize = unit.size;
    if (horizontal && mainSize < unit.titleWidth) {
      unit.mainMin -= (unit.titleWidth - mainSize) / 2;
      unit.mainMax = unit.mainMin + unit.titleWidth;
      mainSize = unit.titleWidth;
    }
    if (!horizontal) crossSize = Math.max(crossSize, unit.titleWidth);

    const rect = toRect(unit.mainMin, unit.crossStart, Math.round(mainSize), Math.round(crossSize));
    groups.set(unit.id, {
      id: unit.id,
      ...rect,
      depth,
      titleRect: { x: rect.x + 8, y: rect.y + 5, w: unit.titleWidth - 12, h: 18 },
    });
  };
  placeRects(root, [], 0);

  const routes = routeEdges(
    {
      rects,
      groups: [...groups.values()],
      edges: model.edges,
      ancestorsOf: (id) => ancestors.get(id) ?? [],
      horizontal,
    },
    cfg.routing,
  );
  const labels = placeLabels(routes, model, rects, measure);

  const edges = new Map();
  for (const edge of model.edges) {
    edges.set(edge.key, { key: edge.key, points: routes.get(edge.key), label: labels.get(edge.key) ?? null });
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x, y, w = 0, h = 0) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + w);
    maxY = Math.max(maxY, y + h);
  };
  for (const r of rects.values()) grow(r.x, r.y, r.w, r.h);
  for (const g of groups.values()) grow(g.x, g.y, g.w, g.h);
  for (const e of edges.values()) {
    for (const p of e.points ?? []) grow(p.x, p.y);
    if (e.label) grow(e.label.x, e.label.y, e.label.w, e.label.h);
  }
  const bounds = Number.isFinite(minX)
    ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    : { x: 0, y: 0, w: 0, h: 0 };

  return { horizontal, nodes, groups, edges, notes, bounds };
}
