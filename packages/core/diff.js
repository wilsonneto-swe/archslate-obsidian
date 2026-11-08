// Structural comparison of two parsed diagrams. Identity is the declared id, so
// renaming a label reads as a change to the same component rather than as one
// component removed and another added.
//
// unionModel() produces something layoutDiagram() can draw directly: everything
// from `after`, plus ghosts of whatever only existed in `before`, each tagged
// with a status of same | added | removed | changed.

import { KINDS, OPS } from './kinds.js';

/** @typedef {import('../types').Model} Model */
/** @typedef {import('../types').UnionModel} UnionModel */
/** @typedef {import('../types').DiffSummary} DiffSummary */
/** @typedef {import('../types').DiffStatus} DiffStatus */
/** @typedef {import('../types').DiffNode} DiffNode */
/** @typedef {import('../types').DiffEdge} DiffEdge */
/** @typedef {import('../types').DiffGroup} DiffGroup */
/** @typedef {import('../types').DiffNote} DiffNote */
/** @typedef {import('../types').DiagramNode} DiagramNode */
/** @typedef {import('../types').DiagramEdge} DiagramEdge */
/** @typedef {import('../types').DiagramNote} DiagramNote */
/** @typedef {import('../types').DiagramFlow} DiagramFlow */

/**
 * The kinds of item the summary counts: the fields of a DiffSummary that are DiffCounts.
 * @typedef {'nodes' | 'edges' | 'groups' | 'notes' | 'flows'} DiffBucket
 */

/**
 * The older note a note of the newer version pairs up with; `changed` when its
 * text is not the same.
 * @typedef {{ previous: DiagramNote, changed: boolean }} NotePair
 */

/** @type {(a: string[], b: string[]) => boolean} */
const sameList = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
/** @type {(count: DiagramNode['count']) => string} */
const countText = (count) => `×${count ?? 1}`;
/** @type {(props: string[]) => string} */
const propsNote = (props) => (props.length ? `was [${props.join(', ')}]` : 'details added');

/**
 * Pairs each link of the newer version with a link of the older one between the
 * same components, closest match first; `removed` are the older links left over.
 * @param {DiagramEdge[]} before
 * @param {DiagramEdge[]} after
 * @returns {{ pairs: Map<DiagramEdge, DiagramEdge>, removed: DiagramEdge[] }}
 */
function pairEdges(before, after) {
  const remaining = [...before];
  /** @type {Map<DiagramEdge, DiagramEdge>} */
  const pairs = new Map();
  /** @type {(predicate: (e: DiagramEdge) => boolean) => DiagramEdge | null} */
  const take = (predicate) => {
    const index = remaining.findIndex(predicate);
    return index >= 0 ? remaining.splice(index, 1)[0] : null;
  };
  // Closest matches first: with parallel links ("a -> b: reads" and
  // "a -> b: writes", or "a -> b" and "a --> b"), deleting or changing one is
  // not read as a change to the other.
  /** @type {Array<(e: DiagramEdge, edge: DiagramEdge) => boolean>} */
  const passes = [
    (e, edge) => e.op === edge.op && e.label === edge.label && sameList(e.props, edge.props),
    (e, edge) => e.op === edge.op && e.label === edge.label,
    (e, edge) => e.op === edge.op,
    () => true,
  ];
  for (const same of passes) {
    for (const edge of after) {
      if (pairs.has(edge)) continue;
      const match = take((e) => e.from === edge.from && e.to === edge.to && same(e, edge));
      if (match) pairs.set(edge, match);
    }
  }
  return { pairs, removed: remaining };
}

// Notes have no id. Same text on the same component is the same note; what is
// left over on a component pairs up in order as edits.
/**
 * @param {DiagramNote[]} before
 * @param {DiagramNote[]} after
 * @returns {{ pairs: Map<DiagramNote, NotePair>, removed: DiagramNote[] }}
 */
function pairNotes(before, after) {
  const remaining = [...before];
  /** @type {Map<DiagramNote, NotePair>} */
  const pairs = new Map();
  for (const note of after) {
    const index = remaining.findIndex((n) => n.target === note.target && n.text === note.text);
    if (index >= 0) pairs.set(note, { previous: remaining.splice(index, 1)[0], changed: false });
  }
  for (const note of after) {
    if (pairs.has(note)) continue;
    const index = remaining.findIndex((n) => n.target === note.target);
    if (index >= 0) pairs.set(note, { previous: remaining.splice(index, 1)[0], changed: true });
  }
  return { pairs, removed: remaining };
}

/**
 * @param {DiagramNode} previous
 * @param {DiagramNode} node
 * @returns {boolean}
 */
function nodeChanged(previous, node) {
  return (
    previous.label !== node.label ||
    previous.kind !== node.kind ||
    previous.group !== node.group ||
    previous.count !== node.count ||
    !sameList(previous.props, node.props)
  );
}

/**
 * What changed on a component, for its caption.
 * @param {DiagramNode} previous
 * @param {DiagramNode} node
 * @returns {string}
 */
function nodeNote(previous, node) {
  if (previous.label !== node.label) return `was "${previous.label}"`;
  if (previous.kind !== node.kind) return `was ${KINDS[previous.kind]?.label ?? previous.kind}`;
  if (previous.count !== node.count) {
    const scaled = (node.count === 'N' ? Infinity : node.count ?? 1) > (previous.count === 'N' ? Infinity : previous.count ?? 1);
    return `${scaled ? 'scaled out' : 'scaled in'}, was ${countText(previous.count)}`;
  }
  if (!sameList(previous.props, node.props)) return propsNote(previous.props);
  return previous.group ? `moved from ${previous.group}` : 'moved into group';
}

/**
 * What changed on a link, for its label.
 * @param {DiagramEdge} previous
 * @param {DiagramEdge} edge
 * @returns {string}
 */
function edgeNote(previous, edge) {
  /** @type {string[]} */
  const notes = [];
  if (previous.op !== edge.op) notes.push(`was ${OPS[previous.op]?.name ?? previous.op}`);
  if (previous.label !== edge.label) {
    notes.push(previous.label ? `was "${previous.label}"` : 'label added');
  }
  if (!sameList(previous.props, edge.props)) notes.push(propsNote(previous.props));
  return notes.join(', ');
}

/** @type {(flow: DiagramFlow) => string} */
const stepsKey = (flow) => JSON.stringify([flow.label, flow.steps.map((s) => [s.from, s.op, s.to, s.label])]);

/**
 * @param {Model} before
 * @param {Model} after
 * @returns {UnionModel}
 */
export function unionModel(before, after) {
  /** @type {DiffSummary} */
  const summary = {
    nodes: { added: 0, removed: 0, changed: 0 },
    edges: { added: 0, removed: 0, changed: 0 },
    groups: { added: 0, removed: 0, changed: 0 },
    notes: { added: 0, removed: 0, changed: 0 },
    flows: { added: 0, removed: 0, changed: 0 },
    markdownChanged: before.markdown.trim() !== after.markdown.trim(),
    directionChanged: before.direction !== after.direction,
  };
  /** @type {(bucket: DiffBucket, status: DiffStatus) => void} */
  const count = (bucket, status) => {
    if (status !== 'same') summary[bucket][status] += 1;
  };

  /** @type {DiffNode[]} */
  const nodes = after.nodes.map((node) => {
    const previous = before.nodeById.get(node.id);
    /** @type {DiffStatus} */
    let status = 'added';
    /** @type {string | undefined} */
    let caption;
    if (previous) {
      const changed = nodeChanged(previous, node);
      status = changed ? 'changed' : 'same';
      if (changed) caption = nodeNote(previous, node);
    }
    count('nodes', status);
    return { ...node, status, caption };
  });
  for (const node of before.nodes) {
    if (!after.nodeById.has(node.id)) {
      count('nodes', 'removed');
      nodes.push({ ...node, status: 'removed', line: node.line + 0.5 });
    }
  }

  /** @type {DiffGroup[]} */
  const groups = after.groups.map((group) => {
    const previous = before.groupById.get(group.id);
    /** @type {DiffStatus} */
    let status = 'added';
    if (previous) status = previous.label !== group.label || previous.parent !== group.parent ? 'changed' : 'same';
    count('groups', status);
    return { ...group, status };
  });
  for (const group of before.groups) {
    if (!after.groupById.has(group.id)) {
      count('groups', 'removed');
      groups.push({ ...group, status: 'removed', line: group.line + 0.5 });
    }
  }

  const { pairs, removed } = pairEdges(before.edges, after.edges);
  /** @type {DiffEdge[]} */
  const edges = after.edges.map((edge) => {
    const previous = pairs.get(edge);
    /** @type {DiffStatus} */
    let status = 'added';
    /** @type {string | undefined} */
    let displayLabel;
    if (previous) {
      const changed = previous.op !== edge.op || previous.label !== edge.label || !sameList(previous.props, edge.props);
      status = changed ? 'changed' : 'same';
      if (changed) {
        const note = edgeNote(previous, edge);
        displayLabel = edge.label ? `${edge.label} (${note})` : note;
      }
    }
    count('edges', status);
    return { ...edge, status, displayLabel };
  });
  for (const edge of removed) {
    count('edges', 'removed');
    edges.push({ ...edge, key: `~${edge.key}`, status: 'removed' });
  }

  // Flows are compared by id: their title and steps.
  for (const flow of after.flows) {
    const previous = before.flowById.get(flow.id);
    count('flows', !previous ? 'added' : stepsKey(previous) !== stepsKey(flow) ? 'changed' : 'same');
  }
  for (const flow of before.flows) {
    if (!after.flowById.has(flow.id)) count('flows', 'removed');
  }

  const notePairs = pairNotes(before.notes, after.notes);
  /** @type {DiffNote[]} */
  const notes = after.notes.map((note) => {
    const pair = notePairs.pairs.get(note);
    const status = !pair ? 'added' : pair.changed ? 'changed' : 'same';
    count('notes', status);
    return { ...note, status };
  });
  for (const note of notePairs.removed) {
    count('notes', 'removed');
    notes.push({ ...note, key: `~${note.key}`, status: 'removed', line: note.line + 0.5 });
  }

  return {
    direction: after.direction,
    nodes,
    groups,
    edges,
    notes,
    flows: after.flows,
    markdown: after.markdown,
    nodeById: new Map(nodes.map((node) => [node.id, node])),
    groupById: new Map(groups.map((group) => [group.id, group])),
    edgeByKey: new Map(edges.map((edge) => [edge.key, edge])),
    noteByKey: new Map(notes.map((note) => [note.key, note])),
    summary,
  };
}

/**
 * Whether nothing at all changed.
 * @param {DiffSummary} summary
 * @returns {boolean}
 */
export function isEmptySummary(summary) {
  if (summary.markdownChanged || summary.directionChanged) return false;
  return Object.values(summary).every((/** @type {DiffSummary[keyof DiffSummary]} */ bucket) => {
    return typeof bucket !== 'object' || (bucket.added === 0 && bucket.removed === 0 && bucket.changed === 0);
  });
}
