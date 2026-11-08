// Draws a laid-out model as SVG. Nodes, groups and notes are keyed and kept
// between renders, so a relayout slides them to their new place (CSS
// transitions) instead of redrawing from scratch. Links are cheap and are
// rebuilt each time.

import { KINDS, OPS } from '../core/kinds.js';
import { svg, setAttrs, viewOf } from './dom.js';
import { KIND_ICONS } from './icons.js';

const HEAD = 9;

function roundedPath(points, radius = 7) {
  if (points.length < 2) return '';
  let d = `M${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1];
    const here = points[i];
    const next = points[i + 1];
    const inLen = Math.abs(here.x - prev.x) + Math.abs(here.y - prev.y);
    const outLen = Math.abs(next.x - here.x) + Math.abs(next.y - here.y);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    const ax = here.x - Math.sign(here.x - prev.x) * r;
    const ay = here.y - Math.sign(here.y - prev.y) * r;
    const bx = here.x + Math.sign(next.x - here.x) * r;
    const by = here.y + Math.sign(next.y - here.y) * r;
    d += `L${ax} ${ay}Q${here.x} ${here.y} ${bx} ${by}`;
  }
  const last = points.at(-1);
  return `${d}L${last.x} ${last.y}`;
}

// Pulls the final point back so the stroke ends under the arrowhead, and
// returns the head geometry.
function arrowHead(points, filled) {
  const tip = points.at(-1);
  const from = points.at(-2);
  const dx = Math.sign(tip.x - from.x);
  const dy = Math.sign(tip.y - from.y);
  const back = { x: tip.x - dx * HEAD, y: tip.y - dy * HEAD };
  const wing = HEAD * 0.55;
  const left = { x: back.x - dy * wing, y: back.y + dx * wing };
  const right = { x: back.x + dy * wing, y: back.y - dx * wing };
  const head = filled
    ? `M${tip.x} ${tip.y}L${left.x} ${left.y}L${right.x} ${right.y}Z`
    : `M${left.x} ${left.y}L${tip.x} ${tip.y}L${right.x} ${right.y}`;
  const trimmed = points.slice(0, -1).concat(filled ? back : { x: tip.x - dx * 1.5, y: tip.y - dy * 1.5 });
  return { head, trimmed };
}

function edgeGeometry(points, op) {
  if (op === '<->') {
    const end = arrowHead(points, true);
    const start = arrowHead([...end.trimmed].reverse(), true);
    return { heads: [end.head, start.head], trimmed: [...start.trimmed].reverse(), filled: true };
  }
  const filled = op === '->';
  const { head, trimmed } = arrowHead(points, filled);
  return { heads: [head], trimmed, filled };
}

const flowClass = (item) => (item.flow === 'out' ? ' is-dimmed' : item.flow === 'in' ? ' is-flow' : '');

export class DiagramRenderer {
  constructor() {
    this.groupLayer = svg('g', { class: 'sd-layer-groups' });
    this.edgeLayer = svg('g', { class: 'sd-layer-edges' });
    this.nodeLayer = svg('g', { class: 'sd-layer-nodes' });
    this.noteLayer = svg('g', { class: 'sd-layer-notes' });
    this.labelLayer = svg('g', { class: 'sd-layer-labels' });
    this.toolLayer = svg('g', { class: 'sd-layer-tools' });
    this.viewport = svg(
      'g',
      { class: 'sd-viewport' },
      this.groupLayer,
      this.edgeLayer,
      this.nodeLayer,
      this.noteLayer,
      this.labelLayer,
      this.toolLayer,
    );
    this.svg = svg('svg', { class: 'sd-svg', role: 'img', 'aria-label': 'Diagram' }, this.viewport);

    this.nodeEls = new Map();
    this.groupEls = new Map();
    this.edgeEls = new Map();
    this.noteEls = new Map();
    this.noteItemEls = new Map();
    this.positions = new Map();
    this.selection = null;
  }

  setView({ k, tx, ty }) {
    this.viewport.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
  }

  update(model, layout) {
    const moved = this.updateGroups(model, layout) | this.updateNodes(model, layout);
    this.updateNotes(layout);
    this.updateEdges(model, layout, moved);
    this.applySelection();
  }

  updateGroups(model, layout) {
    let moved = false;
    const live = new Set();
    for (const group of model.groups) {
      const box = layout.groups.get(group.id);
      if (!box) continue;
      live.add(group.id);
      let entry = this.groupEls.get(group.id);
      if (!entry) {
        const rect = svg('rect', { class: 'sd-group-box', rx: 14 });
        const title = svg('text', { class: 'sd-group-title', x: 14, y: 18 });
        const root = svg('g', { class: 'sd-group sd-enter', 'data-group': group.id }, rect, title);
        this.groupLayer.append(root);
        entry = { root, rect, title };
        this.groupEls.set(group.id, entry);
      } else {
        const before = this.positions.get(`g:${group.id}`);
        if (before && (before.x !== box.x || before.y !== box.y || before.w !== box.w || before.h !== box.h)) {
          moved = true;
        }
      }
      this.positions.set(`g:${group.id}`, box);
      entry.root.setAttribute('class', `sd-group${group.status ? ` is-${group.status}` : ''}`);
      entry.root.style.transform = `translate(${box.x}px, ${box.y}px)`;
      setAttrs(entry.rect, { width: box.w, height: box.h });
      entry.rect.style.width = `${box.w}px`;
      entry.rect.style.height = `${box.h}px`;
      entry.title.textContent = group.label;
      entry.root.toggleAttribute('data-ghost', group.status === 'removed');
    }
    for (const [id, entry] of this.groupEls) {
      if (!live.has(id)) {
        entry.root.remove();
        this.groupEls.delete(id);
        this.positions.delete(`g:${id}`);
      }
    }
    return moved;
  }

  updateNodes(model, layout) {
    let moved = false;
    const live = new Set();
    for (const node of model.nodes) {
      const box = layout.nodes.get(node.id);
      if (!box) continue;
      live.add(node.id);
      const category = KINDS[node.kind]?.category ?? 'compute';
      let entry = this.nodeEls.get(node.id);
      if (!entry) {
        const root = svg('g', { 'data-node': node.id });
        root.classList.add('sd-enter');
        this.nodeLayer.append(root);
        entry = { root, signature: '' };
        this.nodeEls.set(node.id, entry);
      } else {
        const before = this.positions.get(`n:${node.id}`);
        if (before && (before.x !== box.x || before.y !== box.y)) moved = true;
      }
      this.positions.set(`n:${node.id}`, box);

      const status = node.status ? ` is-${node.status}` : '';
      const enter = entry.root.classList.contains('sd-enter') ? ' sd-enter' : '';
      entry.root.setAttribute('class', `sd-node sd-cat-${category}${status}${flowClass(node)}${enter}`);
      entry.root.style.transform = `translate(${box.x}px, ${box.y}px)`;
      entry.root.dataset.line = Number.isInteger(node.line) ? node.line : '';
      entry.root.toggleAttribute('data-ghost', node.status === 'removed');

      const signature = [box.w, box.h, node.kind, box.labelText, box.captionText, node.label, box.countText, ...box.propLines, node.status].join('|');
      if (signature !== entry.signature) {
        entry.signature = signature;
        entry.root.replaceChildren(...this.nodeContent(node, box));
      }
    }
    for (const [id, entry] of this.nodeEls) {
      if (!live.has(id)) {
        entry.root.remove();
        this.nodeEls.delete(id);
        this.positions.delete(`n:${id}`);
      }
    }
    // Let the enter animation play once.
    viewOf(this.svg).requestAnimationFrame(() => {
      for (const { root } of this.nodeEls.values()) root.classList.remove('sd-enter');
      for (const { root } of this.groupEls.values()) root.classList.remove('sd-enter');
      for (const { root } of this.noteEls.values()) root.classList.remove('sd-enter');
    });
    return moved;
  }

  nodeContent(node, box) {
    const stack = box.stack ?? 0;
    const w = box.w - stack;
    const h = box.h - stack;
    const kindLabel = KINDS[node.kind]?.label ?? node.kind;
    const tooltip = [`${node.label} (${kindLabel}${node.count ? `, ×${node.count}` : ''})`, ...(node.props ?? [])].join('\n');

    const card = [
      svg('rect', { class: 'sd-node-box', width: w, height: h, rx: 11 }),
      svg('rect', { class: 'sd-node-tile', x: 10, y: 10, width: 36, height: 36, rx: 9 }),
      svg(
        'svg',
        {
          class: 'sd-node-icon',
          x: 16,
          y: 16,
          width: 24,
          height: 24,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.6,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        },
        svg('path', { d: KIND_ICONS[node.kind] ?? KIND_ICONS.service }),
      ),
      svg('text', { class: 'sd-node-label', x: 56, y: 25, text: box.labelText }),
      svg('text', { class: 'sd-node-caption', x: 56, y: 41, text: box.captionText }),
      ...box.propLines.map((line, i) => svg('text', { class: 'sd-node-prop', x: 56, y: 57 + i * 14, text: line })),
    ];
    if (box.countText) {
      card.push(
        svg(
          'g',
          { class: 'sd-node-count', transform: `translate(${w - box.countWidth - 8} 9)` },
          svg('rect', { width: box.countWidth, height: 16, rx: 8 }),
          svg('text', { x: box.countWidth / 2, y: 11.5, text: box.countText }),
        ),
      );
    }

    const children = [svg('title', { text: tooltip })];
    if (stack) {
      // Two cards peeking out behind: "several identical copies".
      children.push(
        svg('rect', { class: 'sd-node-stack', x: stack, y: 0, width: w, height: h, rx: 11 }),
        svg('rect', { class: 'sd-node-stack', x: stack / 2, y: stack / 2, width: w, height: h, rx: 11 }),
        svg('g', { transform: `translate(0 ${stack})` }, ...card),
      );
    } else {
      children.push(...card);
    }
    if (node.status && node.status !== 'same') {
      const glyph = { added: '+', removed: '−', changed: '~' }[node.status];
      children.push(
        svg(
          'g',
          { class: 'sd-node-badge', transform: `translate(${box.w - 2} 2)` },
          svg('circle', { r: 8 }),
          svg('text', { y: 4, text: glyph }),
        ),
      );
    }
    return children;
  }

  updateNotes(layout) {
    const live = new Set();
    this.noteItemEls.clear();
    for (const [target, block] of layout.notes ?? []) {
      live.add(target);
      let entry = this.noteEls.get(target);
      if (!entry) {
        const root = svg('g', { class: 'sd-notes sd-enter' });
        this.noteLayer.append(root);
        entry = { root, signature: '', items: new Map() };
        this.noteEls.set(target, entry);
      }
      entry.root.style.transform = `translate(${block.x}px, ${block.y}px)`;

      const signature = JSON.stringify([block.w, block.h, block.tie, block.x, block.y, block.items.map((i) => [i.key, i.lines, i.status, i.flow, i.line, i.y])]);
      if (signature !== entry.signature) {
        entry.signature = signature;
        entry.items = new Map();
        const [a, b] = block.tie;
        const tie = svg('path', {
          class: `sd-note-tie${block.items.every((i) => i.flow === 'out') ? ' is-dimmed' : ''}`,
          d: `M${a.x - block.x} ${a.y - block.y}L${b.x - block.x} ${b.y - block.y}`,
        });
        const items = block.items.map((item) => {
          const element = svg(
            'g',
            {
              class: `sd-note${item.status ? ` is-${item.status}` : ''}${flowClass(item)}`,
              'data-note': item.key,
              'data-line': Number.isInteger(item.line) ? item.line : '',
              transform: `translate(0 ${item.y - block.y})`,
            },
            svg('rect', { class: 'sd-note-box', width: item.w, height: item.h, rx: 5 }),
            ...item.lines.map((line, i) => svg('text', { class: 'sd-note-text', x: 8, y: 19 + i * 15, text: line })),
          );
          if (item.status === 'removed') element.setAttribute('data-ghost', '');
          entry.items.set(item.key, element);
          return element;
        });
        entry.root.replaceChildren(tie, ...items);
      }
      for (const [key, element] of entry.items) this.noteItemEls.set(key, element);
    }
    for (const [target, entry] of this.noteEls) {
      if (!live.has(target)) {
        entry.root.remove();
        this.noteEls.delete(target);
      }
    }
  }

  updateEdges(model, layout, moved) {
    this.edgeLayer.replaceChildren();
    this.labelLayer.replaceChildren();
    this.edgeEls.clear();
    const fade = moved ? ' sd-fade' : '';

    for (const edge of model.edges) {
      const geometry = layout.edges.get(edge.key);
      if (!geometry?.points || geometry.points.length < 2) continue;
      const kind = OPS[edge.op]?.name ?? 'request';
      const classes = `sd-edge-${kind}${edge.status ? ` is-${edge.status}` : ''}${flowClass(edge)}${fade}`;
      const { heads, trimmed, filled } = edgeGeometry(geometry.points, edge.op);
      const line = roundedPath(trimmed);
      const root = svg(
        'g',
        {
          class: `sd-edge ${classes}`,
          'data-edge': edge.key,
          'data-line': Number.isInteger(edge.line) ? edge.line : '',
        },
        svg('path', { class: 'sd-edge-hit', d: roundedPath(geometry.points) }),
        svg('path', { class: 'sd-edge-line', d: line }),
        edge.op === '<->' ? svg('path', { class: 'sd-edge-core', d: line }) : null,
        ...heads.map((d) => svg('path', { class: `sd-edge-head${filled ? ' is-filled' : ''}`, d })),
      );
      if (edge.status === 'removed') root.setAttribute('data-ghost', '');
      this.edgeLayer.append(root);

      const label = geometry.label ? this.edgeLabel(edge, geometry.label, classes) : null;
      if (label) this.labelLayer.append(label);
      this.edgeEls.set(edge.key, { root, label, edge });
    }
  }

  edgeLabel(edge, box, classes) {
    const { x, y, w, h, text, propsText, badge, badgeW } = box;
    const parts = [];
    if (badge && !text && !propsText) {
      parts.push(
        svg(
          'g',
          { class: 'sd-step-badge' },
          svg('rect', { x, y, width: w, height: h, rx: h / 2 }),
          svg('text', { x: x + w / 2, y: y + h / 2 + 3.5, text: badge }),
        ),
      );
    } else {
      parts.push(svg('rect', { class: 'sd-edge-label-box', x, y, width: w, height: h, rx: 5 }));
      const offset = badge ? badgeW + 2 : 0;
      if (badge) {
        parts.push(
          svg(
            'g',
            { class: 'sd-step-badge' },
            svg('rect', { x: x + 2, y: y + h / 2 - 7, width: badgeW - 2, height: 14, rx: 7 }),
            svg('text', { x: x + 2 + (badgeW - 2) / 2, y: y + h / 2 + 3.5, text: badge }),
          ),
        );
      }
      const cx = x + offset + (w - offset) / 2;
      if (text && propsText) {
        parts.push(
          svg('text', { class: 'sd-edge-label-text', x: cx, y: y + 12.5, text }),
          svg('text', { class: 'sd-edge-label-props', x: cx, y: y + 24.5, text: propsText }),
        );
      } else if (text) {
        parts.push(svg('text', { class: 'sd-edge-label-text', x: cx, y: y + h / 2 + 3.5, text }));
      } else {
        parts.push(svg('text', { class: 'sd-edge-label-props', x: cx, y: y + h / 2 + 3.5, text: propsText }));
      }
    }
    const label = svg('g', { class: `sd-edge-label ${classes}`, 'data-edge': edge.key }, ...parts);
    if (edge.status === 'removed') label.setAttribute('data-ghost', '');
    return label;
  }

  setSelection(selection) {
    this.selection = selection;
    this.applySelection();
  }

  applySelection() {
    const sel = this.selection;
    for (const [id, { root }] of this.nodeEls) {
      root.classList.toggle('is-selected', sel?.type === 'node' && sel.id === id);
    }
    for (const [id, { root }] of this.groupEls) {
      root.classList.toggle('is-selected', sel?.type === 'group' && sel.id === id);
    }
    for (const [key, element] of this.noteItemEls) {
      element.classList.toggle('is-selected', sel?.type === 'note' && sel.key === key);
    }
    for (const [key, { root, label, edge }] of this.edgeEls) {
      const selected = sel?.type === 'edge' && sel.key === key;
      const connected = sel?.type === 'node' && (edge.from === sel.id || edge.to === sel.id);
      for (const element of [root, label]) {
        element?.classList.toggle('is-selected', selected);
        element?.classList.toggle('is-connected', connected);
      }
    }
  }

  setLinkTarget(id) {
    for (const [nodeId, { root }] of this.nodeEls) {
      root.classList.toggle('is-link-target', nodeId === id);
    }
  }

  // Rubber band shown while linking.
  showLinkPreview(from, to) {
    this.toolLayer.replaceChildren();
    if (!from || !to) return;
    this.toolLayer.append(
      svg('path', { class: 'sd-link-preview', d: `M${from.x} ${from.y}L${to.x} ${to.y}` }),
      svg('circle', { class: 'sd-link-preview-dot', cx: to.x, cy: to.y, r: 4 }),
    );
  }

  hit(target) {
    const element = target instanceof Element ? target : null;
    const ghost = element?.closest('[data-ghost]');
    if (ghost) return null;
    const note = element?.closest('[data-note]');
    if (note) return { type: 'note', key: note.dataset.note };
    const node = element?.closest('[data-node]');
    if (node) return { type: 'node', id: node.dataset.node };
    const edge = element?.closest('[data-edge]');
    if (edge) return { type: 'edge', key: edge.dataset.edge };
    const group = element?.closest('[data-group]');
    if (group) return { type: 'group', id: group.dataset.group };
    return null;
  }
}
