// Every canvas action is a pure text -> text function. The canvas never owns
// state: it calls one of these, and the result is reparsed and redrawn like any
// other change. Untouched lines (comments, spacing, ordering) survive verbatim,
// and nothing is ever written into the markdown section below "---".
//
// Each function returns { text, select }, where `select` is what the UI should
// select afterwards.

import { parse, slugify, splitProps } from './parser.js';

const INDENT = '  ';

function quote(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function formatEdgeLabel(label) {
  const bare = !/["]|\s#|\s\/\/|^#|^\/\/|\]$|^\[/.test(label);
  return bare ? label : quote(label);
}

export function formatProps(props) {
  const list = (Array.isArray(props) ? props : splitProps(props ?? ''))
    .map((part) => part.replace(/[[\]]/g, '').trim())
    .filter(Boolean);
  return list.length ? `[${list.join(', ')}]` : '';
}

// A whole number written as digits (a pasted "3.5" counts as 3), "N" for
// many; anything else, 1 or less drops the marker.
export function formatCount(count) {
  if (count === null || count === undefined) return '';
  const value = String(count).trim().replace(/^[x×]/i, '');
  if (/^n$/i.test(value)) return 'xN';
  const digits = value.match(/^0*(\d{1,15})(?:\.\d*)?$/)?.[1];
  return digits && Number(digits) > 1 ? `x${digits}` : '';
}

function replaceRange(line, start, end, value) {
  return line.slice(0, start) + value + line.slice(end);
}

// Removes a token together with the whitespace in front of it.
function removeToken(line, token) {
  let start = token.start;
  while (start > 0 && /\s/.test(line[start - 1])) start -= 1;
  return replaceRange(line, start, token.end, '');
}

function indentOf(line) {
  return line.match(/^\s*/)[0];
}

function isBlank(line) {
  return line === undefined || line.trim() === '';
}

function uniqueId(model, base) {
  const stem = slugify(base) || 'node';
  let id = stem;
  for (let n = 2; model.nodeById.has(id) || model.groupById.has(id); n += 1) id = `${stem}_${n}`;
  return id;
}

// Removes lines, then collapses any double blank left at the seams.
function removeLines(lines, indices) {
  const doomed = new Set(indices);
  const out = [];
  lines.forEach((line, i) => {
    if (doomed.has(i)) {
      out.seam = true;
      return;
    }
    if (out.seam && isBlank(line) && out.length > 0 && isBlank(out.at(-1))) return;
    out.seam = false;
    out.push(line);
  });
  while (out.length > 1 && isBlank(out[0]) && doomed.has(0)) out.shift();
  return Array.from(out);
}

// A declaration plus the notes written directly under it.
function declarationEnd(model, line) {
  let end = line;
  while (model.lineIndex.get(end + 1)?.type === 'note') end += 1;
  return end;
}

// Where a new member of `groupId` (or of the top level when null) belongs: after
// the last existing member, so the source keeps reading in declaration order.
function memberSlot(model, groupId) {
  if (groupId) {
    const group = model.groupById.get(groupId);
    let last = group.line;
    for (const member of group.members) {
      last = Math.max(last, member.endLine ?? declarationEnd(model, member.line));
    }
    if (!group.closed) last = Math.min(last, model.diagramEnd - 1);
    return { index: last + 1, indent: indentOf(model.lines[group.line]) + INDENT };
  }

  let last = -1;
  let lastClosesGroup = false;
  for (const node of model.nodes) {
    const end = declarationEnd(model, node.line);
    if (node.group === null && end > last) {
      last = end;
      lastClosesGroup = false;
    }
  }
  for (const group of model.groups) {
    if (group.parent === null && group.endLine > last) {
      last = group.endLine;
      lastClosesGroup = true;
    }
  }
  if (last >= 0) {
    return { index: last + 1, indent: '', blankBefore: lastClosesGroup };
  }

  // Empty diagram: go after any leading comments and directives.
  let header = -1;
  for (let i = 0; i < model.diagramEnd; i += 1) {
    const line = model.lines[i].trim();
    if (line === '') continue;
    if (line.startsWith('#') || line.startsWith('//') || line.startsWith('direction')) header = i;
    else break;
  }
  return { index: header + 1, indent: '', blankBefore: header >= 0, blankAfter: true };
}

function insertAt(lines, slot, newLines) {
  const block = [...newLines];
  if (slot.blankBefore && slot.index > 0 && !isBlank(lines[slot.index - 1])) block.unshift('');
  if (slot.blankAfter && !isBlank(lines[slot.index]) && slot.index < lines.length) block.push('');
  const out = [...lines];
  out.splice(slot.index, 0, ...block);
  return out;
}

function selectionAtLine(text, line) {
  return parse(text).lineIndex.get(line) ?? null;
}

function stepsWhere(model, predicate) {
  return model.flows.flatMap((flow) => flow.steps.filter(predicate));
}

export function addNode(text, { kind, label = '', group = null }) {
  const model = parse(text);
  const id = uniqueId(model, label || kind);
  const suffix = label && label !== id ? ` ${quote(label)}` : '';
  const slot = memberSlot(model, group);
  const lines = insertAt(model.lines, slot, [`${slot.indent}${kind} ${id}${suffix}`]);
  return { text: lines.join('\n'), select: { type: 'node', id } };
}

export function addGroup(text, { label = '', parent = null }) {
  const model = parse(text);
  const id = uniqueId(model, label || 'group');
  const title = label && label !== id ? ` ${quote(label)}` : '';
  const slot = memberSlot(model, parent);
  const block = [`${slot.indent}group ${id}${title} {`, `${slot.indent}}`];
  const lines = insertAt(model.lines, { ...slot, blankBefore: !parent || slot.blankBefore }, block);
  return { text: lines.join('\n'), select: { type: 'group', id } };
}

export function addEdge(text, { from, to, op = '->', label = '' }) {
  const model = parse(text);
  const declaration = `${from} ${op} ${to}${label ? `: ${formatEdgeLabel(label)}` : ''}`;

  const rootEdges = model.edges.filter((edge) => {
    return !model.groups.some((g) => g.line < edge.line && edge.line < g.endLine);
  });
  let index;
  let lines;
  if (rootEdges.length > 0) {
    index = Math.max(...rootEdges.map((edge) => edge.line)) + 1;
    lines = insertAt(model.lines, { index }, [declaration]);
  } else {
    // First link: after the declarations, before any flows and the notes.
    let end = Math.min(model.diagramEnd, ...model.flows.map((flow) => flow.line));
    while (end > 0 && isBlank(model.lines[end - 1])) end -= 1;
    index = end > 0 ? end + 1 : 0;
    lines = insertAt(model.lines, { index: end, blankBefore: end > 0, blankAfter: true }, [declaration]);
  }
  const next = lines.join('\n');
  return { text: next, select: selectionAtLine(next, index) };
}

export function removeNode(text, id) {
  const model = parse(text);
  const node = model.nodeById.get(id);
  if (!node) return { text, select: null };
  const doomed = [node.line];
  for (const edge of model.edges) {
    if (edge.from === id || edge.to === id) doomed.push(edge.line);
  }
  for (const note of model.notes) {
    if (note.target === id) doomed.push(note.line);
  }
  for (const step of stepsWhere(model, (s) => s.from === id || s.to === id)) doomed.push(step.line);
  return { text: removeLines(model.lines, doomed).join('\n'), select: null };
}

export function removeEdge(text, key) {
  const model = parse(text);
  const edge = model.edgeByKey.get(key);
  if (!edge) return { text, select: null };
  // A step that can still walk another link between the same two components
  // stays (the parser's own rule: same direction, or a connection backwards).
  const walksAnother = (step) =>
    model.edges.some((e) => e !== edge && ((e.from === step.from && e.to === step.to) || (e.op === '<->' && e.from === step.to && e.to === step.from)));
  const doomed = [edge.line, ...stepsWhere(model, (s) => s.edgeKey === key && !walksAnother(s)).map((s) => s.line)];
  return { text: removeLines(model.lines, doomed).join('\n'), select: null };
}

// Dissolves the box and keeps its contents, one indent level shallower.
export function ungroup(text, id) {
  const model = parse(text);
  const group = model.groupById.get(id);
  if (!group) return { text, select: null };
  const lines = model.lines.map((line, i) => {
    return i > group.line && i < group.endLine && line.startsWith(INDENT)
      ? line.slice(INDENT.length)
      : line;
  });
  const doomed = group.closed ? [group.line, group.endLine] : [group.line];
  return { text: removeLines(lines, doomed).join('\n'), select: null };
}

function editNodeLine(text, id, transform) {
  const model = parse(text);
  const node = model.nodeById.get(id);
  if (!node) return { text, select: null };
  const lines = [...model.lines];
  lines[node.line] = transform(lines[node.line], node.tokens, node);
  return { text: lines.join('\n'), select: { type: 'node', id } };
}

export function setNodeLabel(text, id, label) {
  return editNodeLine(text, id, (line, { id: idToken, label: labelToken }) => {
    const clean = label.trim();
    // Only the label goes: a count or details written before it stay.
    if (clean === '' || clean === id) return labelToken ? removeToken(line, labelToken) : line;
    if (labelToken) return replaceRange(line, labelToken.start, labelToken.end, quote(clean));
    return replaceRange(line, idToken.end, idToken.end, ` ${quote(clean)}`);
  });
}

export function setNodeKind(text, id, kind) {
  return editNodeLine(text, id, (line, tokens) => replaceRange(line, tokens.kind.start, tokens.kind.end, kind));
}

// `count`: a number, "N" for "many", or null / 1 to drop the marker.
export function setNodeCount(text, id, count) {
  return editNodeLine(text, id, (line, tokens) => {
    const value = formatCount(count);
    if (tokens.count) return value ? replaceRange(line, tokens.count.start, tokens.count.end, value) : removeToken(line, tokens.count);
    if (!value) return line;
    const after = (tokens.label ?? tokens.id).end;
    return replaceRange(line, after, after, ` ${value}`);
  });
}

// `props`: an array, or a comma separated string. Empty removes the brackets.
export function setNodeProps(text, id, props) {
  return editNodeLine(text, id, (line, tokens) => {
    const value = formatProps(props);
    if (tokens.props) return value ? replaceRange(line, tokens.props.start, tokens.props.end, value) : removeToken(line, tokens.props);
    if (!value) return line;
    const after = Math.max(...[tokens.id, tokens.label, tokens.count].filter(Boolean).map((t) => t.end));
    return replaceRange(line, after, after, ` ${value}`);
  });
}

export function setGroupLabel(text, id, label) {
  const model = parse(text);
  const group = model.groupById.get(id);
  if (!group) return { text, select: null };
  const lines = [...model.lines];
  const { id: idToken, label: labelToken, group: keyword } = group.tokens;
  const line = lines[group.line];
  const clean = label.trim();
  // A group without an id takes it from its title: keep the one it has, so
  // renaming the box doesn't rename the group (links, selection, diffs).
  const title = idToken ? quote(clean || id) : `${id} ${quote(clean || id)}`;
  if (labelToken) {
    lines[group.line] = replaceRange(line, labelToken.start, labelToken.end, title);
  } else {
    const after = (idToken ?? keyword).end;
    lines[group.line] = replaceRange(line, after, after, ` ${title}`);
  }
  return { text: lines.join('\n'), select: { type: 'group', id } };
}

// Moves the declaration, and the notes written under it, into another group.
export function moveNodeToGroup(text, id, groupId) {
  const model = parse(text);
  const node = model.nodeById.get(id);
  if (!node || node.group === groupId) return { text, select: { type: 'node', id } };
  const moving = [node.line];
  for (let line = node.line + 1; model.noteByKey.get(model.lineIndex.get(line)?.key)?.target === id; line += 1) {
    moving.push(line);
  }
  if (groupId && !model.groupById.has(groupId)) return { text, select: { type: 'node', id } };
  const block = moving.map((line) => model.lines[line].trimStart());
  // The slot is found in this model (a group's id may come from its title, and
  // could change once the line is gone): insert first, then remove the old lines.
  const slot = memberSlot(model, groupId);
  const inserted = insertAt(model.lines, slot, block.map((line) => slot.indent + line));
  const added = inserted.length - model.lines.length;
  const lines = removeLines(inserted, moving.map((line) => (line >= slot.index ? line + added : line)));
  return { text: lines.join('\n'), select: { type: 'node', id } };
}

// Applies `transform` to the link's own line and to every flow step walking it.
function editEdgeLines(text, key, transform, stepTransform) {
  const model = parse(text);
  const edge = model.edgeByKey.get(key);
  if (!edge) return { text, select: null };
  const lines = [...model.lines];
  lines[edge.line] = transform(lines[edge.line], edge);
  if (stepTransform) {
    for (const step of stepsWhere(model, (s) => s.edgeKey === key)) {
      lines[step.line] = stepTransform(lines[step.line], step);
    }
  }
  const next = lines.join('\n');
  return { text: next, select: selectionAtLine(next, edge.line) };
}

export function setEdgeOp(text, key, op) {
  const swapArrow = (line, item) => replaceRange(line, item.tokens.arrow.start, item.tokens.arrow.end, op);
  return editEdgeLines(text, key, swapArrow, (line, step) => (step.reversed ? line : swapArrow(line, step)));
}

export function reverseEdge(text, key) {
  const swapEnds = (line, item) => {
    const { from, to } = item.tokens;
    // Later token first, so the earlier offsets stay valid.
    const swapped = replaceRange(line, to.start, to.end, item.from);
    return replaceRange(swapped, from.start, from.end, item.to);
  };
  return editEdgeLines(text, key, swapEnds, swapEnds);
}

export function setEdgeLabel(text, key, label) {
  return editEdgeLines(text, key, (line, edge) => {
    const { to, colon, label: labelToken } = edge.tokens;
    const clean = label.trim();
    const value = clean ? `: ${formatEdgeLabel(clean)}` : '';
    if (colon) return replaceRange(line, colon.start, labelToken?.end ?? colon.end, value);
    return value ? replaceRange(line, to.end, to.end, value) : line;
  });
}

// New details go right after the link's ends (`a -> b [details]: label`):
// after an unquoted label, a "#" in them would read as a comment.
export function setEdgeProps(text, key, props) {
  return editEdgeLines(text, key, (line, edge) => {
    const { to, props: propsToken } = edge.tokens;
    const value = formatProps(props);
    if (propsToken) return value ? replaceRange(line, propsToken.start, propsToken.end, value) : removeToken(line, propsToken);
    if (!value) return line;
    return replaceRange(line, to.end, to.end, ` ${value}`);
  });
}

export function addNote(text, target, noteText) {
  const model = parse(text);
  const node = model.nodeById.get(target);
  const clean = noteText.trim();
  if (!node || !clean) return { text, select: null };
  const index = declarationEnd(model, node.line) + 1;
  const lines = [...model.lines];
  lines.splice(index, 0, `${indentOf(lines[node.line])}note ${target} ${quote(clean)}`);
  const next = lines.join('\n');
  return { text: next, select: selectionAtLine(next, index) };
}

export function setNoteText(text, key, noteText) {
  const model = parse(text);
  const note = model.noteByKey.get(key);
  if (!note) return { text, select: null };
  const clean = noteText.trim();
  if (!clean) return removeNote(text, key);
  const lines = [...model.lines];
  lines[note.line] = replaceRange(lines[note.line], note.tokens.text.start, note.tokens.text.end, quote(clean));
  return { text: lines.join('\n'), select: { type: 'note', key } };
}

export function removeNote(text, key) {
  const model = parse(text);
  const note = model.noteByKey.get(key);
  if (!note) return { text, select: null };
  return { text: removeLines(model.lines, [note.line]).join('\n'), select: null };
}

export function setDirection(text, direction) {
  const model = parse(text);
  if (model.direction === direction && model.directionLine >= 0) return { text, select: null };
  const lines = [...model.lines];
  if (model.directionToken) {
    const { start, end } = model.directionToken;
    lines[model.directionLine] = replaceRange(lines[model.directionLine], start, end, direction);
    return { text: lines.join('\n'), select: null };
  }
  let index = 0;
  while (index < lines.length && /^\s*(#|\/\/)/.test(lines[index])) index += 1;
  const block = [`direction ${direction}`];
  if (!isBlank(lines[index])) block.push('');
  lines.splice(index, 0, ...block);
  return { text: lines.join('\n'), select: null };
}

// Starts the markdown section if there is none. Returns the line the caret
// should go to.
export function ensureMarkdown(text) {
  const model = parse(text);
  if (model.markdownLine >= 0) return { text, line: model.lines.length - 1 };
  const lines = [...model.lines];
  while (lines.length > 0 && isBlank(lines.at(-1))) lines.pop();
  lines.push('', '---', '', '## Notes', '', '');
  return { text: lines.join('\n'), line: lines.length - 1 };
}
