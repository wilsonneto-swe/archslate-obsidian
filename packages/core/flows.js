// Turns a parsed model into the "walk me through it" view of one flow: the
// links it walks get their step numbers (and the step's own text, when it has
// one), and everything else is tagged as outside the flow so the UI can dim it.
// Like unionModel(), the result can go straight into layoutDiagram().

/** @typedef {import('../types').Model} Model */
/** @typedef {import('../types').DiagramFlow} DiagramFlow */
/** @typedef {import('../types').FlowStep} FlowStep */
/** @typedef {import('../types').FlowViewModel} FlowViewModel */
/** @typedef {import('../types').FlowNode} FlowNode */
/** @typedef {import('../types').FlowEdge} FlowEdge */
/** @typedef {import('../types').FlowNote} FlowNote */

/**
 * What the flow's steps say about one link they walk: their numbers, and their
 * texts (each once, in step order).
 * @typedef {{ steps: number[], labels: string[] }} WalkedLink
 */

// The steps that walk a link: what gets a number, and what the step count counts.
/**
 * @param {DiagramFlow} flow
 * @returns {FlowStep[]}
 */
export const walkable = (flow) => flow.steps.filter((step) => step.edgeKey);

/**
 * The model with everything tagged in or out of the flow `flowId`; null when there is no such flow.
 * @param {Model} model
 * @param {string} flowId
 * @returns {FlowViewModel | null}
 */
export function flowView(model, flowId) {
  const flow = model.flowById.get(flowId);
  if (!flow) return null;

  // Steps are numbered 1, 2, 3... in source order; one that walks no link (a
  // typo, a link not declared yet) gets no number and doesn't leave a gap.
  /**
   * The links the flow walks, by key.
   * @type {Map<string, WalkedLink>}
   */
  const byEdge = new Map();
  /**
   * The ids of the components the walked steps go from or to.
   * @type {Set<string>}
   */
  const involved = new Set();
  walkable(flow).forEach((step, index) => {
    const entry = byEdge.get(step.edgeKey) ?? { steps: [], labels: [] };
    entry.steps.push(index + 1);
    if (step.label && !entry.labels.includes(step.label)) entry.labels.push(step.label);
    byEdge.set(step.edgeKey, entry);
    involved.add(step.from);
    involved.add(step.to);
  });

  /** @type {FlowEdge[]} */
  const edges = model.edges.map((edge) => {
    const entry = byEdge.get(edge.key);
    if (!entry) return { ...edge, flow: 'out' };
    const label = entry.labels.length ? entry.labels.join(' · ') : edge.label;
    return { ...edge, flow: 'in', steps: entry.steps, displayLabel: label };
  });
  /** @type {FlowNode[]} */
  const nodes = model.nodes.map((node) => ({ ...node, flow: involved.has(node.id) ? 'in' : 'out' }));
  /** @type {FlowNote[]} */
  const notes = model.notes.map((note) => ({ ...note, flow: involved.has(note.target) ? 'in' : 'out' }));

  return {
    ...model,
    nodes,
    edges,
    notes,
    nodeById: new Map(nodes.map((node) => [node.id, node])),
    edgeByKey: new Map(edges.map((edge) => [edge.key, edge])),
    noteByKey: new Map(notes.map((note) => [note.key, note])),
    flow,
  };
}
