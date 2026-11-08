// Turns a parsed model into the "walk me through it" view of one flow: the
// links it walks get their step numbers (and the step's own text, when it has
// one), and everything else is tagged as outside the flow so the UI can dim it.
// Like unionModel(), the result can go straight into layoutDiagram().

// The steps that walk a link: what gets a number, and what the step count counts.
export const walkable = (flow) => flow.steps.filter((step) => step.edgeKey);

export function flowView(model, flowId) {
  const flow = model.flowById.get(flowId);
  if (!flow) return null;

  // Steps are numbered 1, 2, 3... in source order; one that walks no link (a
  // typo, a link not declared yet) gets no number and doesn't leave a gap.
  const byEdge = new Map();
  const involved = new Set();
  walkable(flow).forEach((step, index) => {
    const entry = byEdge.get(step.edgeKey) ?? { steps: [], labels: [] };
    entry.steps.push(index + 1);
    if (step.label && !entry.labels.includes(step.label)) entry.labels.push(step.label);
    byEdge.set(step.edgeKey, entry);
    involved.add(step.from);
    involved.add(step.to);
  });

  const edges = model.edges.map((edge) => {
    const entry = byEdge.get(edge.key);
    if (!entry) return { ...edge, flow: 'out' };
    const label = entry.labels.length ? entry.labels.join(' · ') : edge.label;
    return { ...edge, flow: 'in', steps: entry.steps, displayLabel: label };
  });
  const nodes = model.nodes.map((node) => ({ ...node, flow: involved.has(node.id) ? 'in' : 'out' }));
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
