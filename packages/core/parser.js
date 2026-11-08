// Line-oriented parser for the diagram language. Every declaration occupies one
// line and remembers where its tokens are, which is what lets canvas actions be
// expressed as small edits to the source (see edits.js).
//
//   direction right|down
//   <kind> <id> ["Label"] [x3|xN] [[detail, detail]]
//   group [id] ["Title"] {
//   }
//   <from> -> <to>[: label] [[detail]]     request / response
//   <from> --> <to>[: label]               event, asynchronous ("=>" also works)
//   <from> <-> <to>[: label]               open two-way connection
//   note <id> "text"                       sticky note on a component
//   flow [id] ["Title"] {                  numbered walkthrough over existing links
//     <from> -> <to>[: what happens]
//   }
//   ---                                    everything below is free markdown
//
// Problems never throw. They become entries in `model.errors` and the offending
// line is skipped, so a half-typed line leaves the rest of the diagram on screen.

import { KIND_NAMES, LEGACY_OPS, resolveKind } from './kinds.js';

// Names are letters (with their combining marks: Devanagari, Thai...), digits,
// "_", "." and "-".
const WORD_CHAR = /[\p{L}\p{M}\p{N}_.-]/u;
const ARROWS = ['<->', '-->', '->', '=>'];
const COUNT = /^x(\d+|n)$/i;
// Deeper nesting than any drawing needs: past it, the layout's tree walks
// would run out of stack.
const MAX_GROUP_DEPTH = 40;
// Pasted text brings no-break and zero-width spaces: they separate like a space.
const isSpace = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\u00a0' || c === '\u200b' || c === '\ufeff' || /\p{Zs}/u.test(c);
// The character at `i`, a whole code point (letters past U+FFFF are two units).
const charAt = (line, i) => String.fromCodePoint(line.codePointAt(i));

export const SEPARATOR = '---';
export const isSeparator = (line) => line.trim() === SEPARATOR;

function arrowAt(line, i) {
  return ARROWS.find((arrow) => line.startsWith(arrow, i)) ?? null;
}

function readString(line, start) {
  let value = '';
  let i = start + 1;
  while (i < line.length) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) {
      value += line[i + 1];
      i += 2;
    } else if (c === '"') {
      return { type: 'string', value, start, end: i + 1, closed: true };
    } else {
      value += c;
      i += 1;
    }
  }
  return { type: 'string', value, start, end: line.length, closed: false };
}

// Unquoted text after ":" runs to the end of the line. A comment only starts
// after whitespace there, so "http://x" and "#1" inside a label survive. A
// trailing "[...]" is split off as the link's details.
function readRawText(line, start) {
  let i = start;
  while (i < line.length && isSpace(line[i])) i += 1;
  if (i >= line.length || line[i] === '"') return { next: i, tokens: [] };
  if (line[i] === '#' || line.startsWith('//', i)) return { next: i, tokens: [] };

  let end = line.length;
  for (let j = i + 1; j < line.length; j += 1) {
    if ((line[j] === '#' || line.startsWith('//', j)) && isSpace(line[j - 1])) {
      end = j;
      break;
    }
  }
  let tokenEnd = end;
  while (tokenEnd > i && isSpace(line[tokenEnd - 1])) tokenEnd -= 1;

  const tokens = [];
  let labelEnd = tokenEnd;
  if (line[tokenEnd - 1] === ']') {
    const open = line.lastIndexOf('[', tokenEnd - 1);
    if (open >= i) {
      tokens.push({ type: 'props', value: line.slice(open + 1, tokenEnd - 1), start: open, end: tokenEnd, closed: true });
      labelEnd = open;
      while (labelEnd > i && isSpace(line[labelEnd - 1])) labelEnd -= 1;
    }
  }
  if (labelEnd > i) tokens.unshift({ type: 'text', value: line.slice(i, labelEnd), start: i, end: labelEnd });
  return { next: end, tokens };
}

export function tokenizeLine(line) {
  const tokens = [];
  const problems = [];
  let comment = null;
  let i = 0;

  while (i < line.length) {
    const c = line[i];
    const arrow = arrowAt(line, i);
    if (isSpace(c)) {
      i += 1;
    } else if (c === '#' || line.startsWith('//', i)) {
      comment = { start: i, end: line.length };
      break;
    } else if (c === '"') {
      const token = readString(line, i);
      tokens.push(token);
      if (!token.closed) {
        problems.push({ start: i, end: line.length, message: 'Missing closing quote' });
      }
      i = token.end;
    } else if (arrow) {
      const value = LEGACY_OPS[arrow] ?? arrow;
      tokens.push({ type: 'arrow', value, raw: arrow, start: i, end: i + arrow.length });
      i += arrow.length;
    } else if (c === ':') {
      tokens.push({ type: 'colon', value: ':', start: i, end: i + 1 });
      const raw = readRawText(line, i + 1);
      tokens.push(...raw.tokens);
      i = raw.next;
    } else if (c === '[') {
      const close = line.indexOf(']', i + 1);
      const end = close === -1 ? line.length : close + 1;
      tokens.push({ type: 'props', value: line.slice(i + 1, close === -1 ? end : close), start: i, end, closed: close !== -1 });
      if (close === -1) problems.push({ start: i, end, message: 'Missing closing "]"' });
      i = end;
    } else if (c === '{') {
      tokens.push({ type: 'lbrace', value: c, start: i, end: i + 1 });
      i += 1;
    } else if (c === '}') {
      tokens.push({ type: 'rbrace', value: c, start: i, end: i + 1 });
      i += 1;
    } else if (WORD_CHAR.test(charAt(line, i))) {
      let j = i + charAt(line, i).length;
      while (j < line.length && WORD_CHAR.test(charAt(line, j)) && !line.startsWith('->', j) && !line.startsWith('-->', j)) j += charAt(line, j).length;
      tokens.push({ type: 'word', value: line.slice(i, j), start: i, end: j });
      i = j;
    } else {
      const char = charAt(line, i);
      problems.push({ start: i, end: i + char.length, message: `Unexpected character "${char}"` });
      i += char.length;
    }
  }
  return { tokens, comment, problems };
}

export function splitProps(value) {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isCountWord(word) {
  return COUNT.test(word);
}

// "Café orders" -> "cafe_orders": accents on Latin letters go, other scripts
// keep their marks.
export function slugify(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');
}

export function parse(text) {
  const lines = text.split('\n');
  const model = {
    text,
    lines,
    direction: 'right',
    directionLine: -1,
    directionToken: null,
    nodes: [],
    edges: [],
    groups: [],
    notes: [],
    flows: [],
    errors: [],
    nodeById: new Map(),
    groupById: new Map(),
    edgeByKey: new Map(),
    noteByKey: new Map(),
    flowById: new Map(),
    lineIndex: new Map(),
    // Line of the "---" that starts the markdown section, or -1.
    markdownLine: -1,
    // First line that is not diagram source (the separator, or the end).
    diagramEnd: lines.length,
    markdown: '',
  };

  const stack = [];
  let flow = null;
  const pendingEdges = [];
  const pendingNotes = [];
  const taken = new Set();
  const flowIds = new Set();
  const derived = [];

  const fail = (line, token, message) => {
    model.errors.push({
      line,
      start: token?.start ?? 0,
      end: token?.end ?? lines[line].length,
      message,
    });
  };

  const claim = (id, line, token) => {
    if (taken.has(id)) {
      fail(line, token, `"${id}" is already declared`);
      return false;
    }
    taken.add(id);
    return true;
  };

  const parseNode = (tokens, line) => {
    const [kindToken, idToken, ...rest] = tokens;
    const kind = resolveKind(kindToken.value);
    if (!kind) {
      fail(line, kindToken, `Unknown type "${kindToken.value}". Types: ${KIND_NAMES.join(', ')}`);
      return;
    }
    if (idToken?.type !== 'word') {
      fail(line, idToken ?? kindToken, `Expected a name after "${kindToken.value}"`);
      return;
    }

    let labelToken = null;
    let countToken = null;
    let propsToken = null;
    for (const [index, token] of rest.entries()) {
      if (token.type === 'string' && !labelToken) {
        labelToken = token;
      } else if (token.type === 'word' && !countToken && COUNT.test(token.value)) {
        countToken = token;
      } else if (token.type === 'props' && !propsToken) {
        propsToken = token;
      } else if (token.type === 'word' && index === 0) {
        fail(line, token, 'Labels must be quoted, for example: service api "Orders API"');
        return;
      } else {
        fail(line, token, 'Unexpected text. After the name: an optional "Label", x3 and [details]');
        return;
      }
    }

    let count = null;
    if (countToken) {
      const value = countToken.value.slice(1);
      count = /^n$/i.test(value) ? 'N' : Number(value);
      if (count === 0) {
        fail(line, countToken, 'Use x1 or more, or xN for "many"');
        return;
      }
      if (!Number.isSafeInteger(count) && count !== 'N') {
        fail(line, countToken, 'That number is too large. Use xN for "many"');
        return;
      }
      // x1 is one instance: drawn as a single card, like no count at all.
      if (count === 1) count = null;
    }
    if (!claim(idToken.value, line, idToken)) return;

    const group = stack.at(-1) ?? null;
    const node = {
      id: idToken.value,
      kind,
      label: labelToken?.value || idToken.value,
      group: group?.id ?? null,
      count,
      props: propsToken ? splitProps(propsToken.value) : [],
      line,
      tokens: { kind: kindToken, id: idToken, label: labelToken, count: countToken, props: propsToken },
    };
    model.nodes.push(node);
    model.nodeById.set(node.id, node);
    model.lineIndex.set(line, { type: 'node', id: node.id });
    group?.members.push(node);
  };

  // Shared by groups and flows: `keyword [id] ["Title"] {`.
  const parseBlockHeader = (tokens, line, noun) => {
    let i = 1;
    const idToken = tokens[i]?.type === 'word' ? tokens[i++] : null;
    const labelToken = tokens[i]?.type === 'string' ? tokens[i++] : null;
    const open = tokens[i];
    if (open?.type !== 'lbrace') {
      fail(line, open ?? tokens[0], `Expected "{" to open the ${noun}`);
      return null;
    }
    if (tokens[i + 1]) {
      fail(line, tokens[i + 1], 'Unexpected text after "{"');
      return null;
    }
    if (!idToken && !labelToken) {
      fail(line, tokens[0], `A ${noun} needs a name, for example: ${noun} checkout "Checkout" {`);
      return null;
    }
    return { idToken, labelToken, open };
  };

  const parseGroup = (tokens, line) => {
    const header = parseBlockHeader(tokens, line, 'group');
    if (!header) return;
    if (stack.length >= MAX_GROUP_DEPTH) {
      fail(line, tokens[0], `Groups nest at most ${MAX_GROUP_DEPTH} deep`);
      return;
    }
    const { idToken, labelToken, open } = header;

    let id = idToken?.value;
    if (id) {
      if (!claim(id, line, idToken)) return;
    } else {
      // A title-only group gets its id once every explicit name is known (see
      // nameGroups below), so it never takes a name declared further down.
      id = `\u0000group${derived.length}`;
    }

    const parent = stack.at(-1) ?? null;
    const group = {
      id,
      label: labelToken?.value || id,
      parent: parent?.id ?? null,
      line,
      endLine: lines.length - 1,
      closed: false,
      members: [],
      tokens: { group: tokens[0], id: idToken, label: labelToken, open },
    };
    model.groups.push(group);
    model.groupById.set(id, group);
    model.lineIndex.set(line, { type: 'group', id });
    if (!idToken) derived.push(group);
    parent?.members.push(group);
    stack.push(group);
  };

  // Gives title-only groups their ids: the title's slug, made unique against
  // every name in the diagram.
  const nameGroups = () => {
    for (const group of derived) {
      const temporary = group.id;
      const base = slugify(group.tokens.label.value) || 'group';
      let id = base;
      for (let n = 2; taken.has(id); n += 1) id = `${base}_${n}`;
      taken.add(id);
      group.id = id;
      if (group.label === temporary) group.label = id;
      model.groupById.delete(temporary);
      model.groupById.set(id, group);
      for (const member of group.members) {
        if (member.members) member.parent = id;
        else member.group = id;
      }
    }
    if (derived.length === 0) return;
    for (const [line, entry] of model.lineIndex) {
      if (entry.type === 'group' && entry.id.startsWith('\u0000')) {
        model.lineIndex.set(line, { type: 'group', id: model.groups.find((g) => g.line === line || g.endLine === line)?.id ?? entry.id });
      }
    }
  };

  const parseFlow = (tokens, line) => {
    if (stack.length) {
      fail(line, tokens[0], 'Flows go at the top level, outside groups');
      return;
    }
    const header = parseBlockHeader(tokens, line, 'flow');
    if (!header) return;
    const { idToken, labelToken, open } = header;
    const base = idToken?.value ?? (slugify(labelToken.value) || 'flow');
    if (idToken && flowIds.has(base)) {
      fail(line, idToken, `Flow "${base}" is already declared`);
      return;
    }
    let id = base;
    for (let n = 2; flowIds.has(id); n += 1) id = `${base}_${n}`;
    flowIds.add(id);

    flow = {
      id,
      label: labelToken?.value || id,
      line,
      endLine: lines.length - 1,
      closed: false,
      steps: [],
      tokens: { flow: tokens[0], id: idToken, label: labelToken, open },
    };
    model.flows.push(flow);
    model.flowById.set(id, flow);
  };

  const parseLink = (tokens, line) => {
    const [fromToken, arrow, toToken, ...rest] = tokens;
    if (fromToken.type !== 'word') {
      fail(line, fromToken, 'Expected a name before the arrow');
      return null;
    }
    if (toToken?.type !== 'word') {
      fail(line, toToken ?? arrow, 'Expected a name after the arrow');
      return null;
    }
    let colon = null;
    let labelToken = null;
    let propsToken = null;
    for (const token of rest) {
      if (token.type === 'arrow') {
        fail(line, token, 'One link per line. Split this into two lines');
        return null;
      }
      if (token.type === 'colon' && !colon && !labelToken) {
        colon = token;
      } else if (colon && !labelToken && (token.type === 'text' || token.type === 'string')) {
        labelToken = token;
      } else if (token.type === 'props' && !propsToken) {
        propsToken = token;
      } else if (!colon && (token.type === 'word' || token.type === 'string')) {
        fail(line, token, 'Use ":" before the link label');
        return null;
      } else {
        fail(line, token, 'Unexpected text after the link label');
        return null;
      }
    }
    return {
      from: fromToken.value,
      to: toToken.value,
      op: arrow.value,
      label: labelToken?.value ?? '',
      props: propsToken ? splitProps(propsToken.value) : [],
      line,
      tokens: { from: fromToken, arrow, to: toToken, colon, label: labelToken, props: propsToken },
    };
  };

  const parseNote = (tokens, line) => {
    const [keyword, targetToken, textToken, extra] = tokens;
    if (targetToken?.type !== 'word') {
      fail(line, targetToken ?? keyword, 'Expected a component name after "note"');
      return;
    }
    if (textToken?.type !== 'string') {
      fail(line, textToken ?? targetToken, 'Note text must be quoted, for example: note api "Rate limited per user"');
      return;
    }
    if (extra) {
      fail(line, extra, 'Unexpected text after the note');
      return;
    }
    pendingNotes.push({
      target: targetToken.value,
      text: textToken.value,
      line,
      tokens: { keyword, target: targetToken, text: textToken },
    });
  };

  const parseFlowLine = (tokens, line) => {
    const [first, second] = tokens;
    if (first.type === 'rbrace') {
      flow.endLine = line;
      flow.closed = true;
      flow.tokens.close = first;
      if (second) fail(line, second, 'Unexpected text after "}"');
      flow = null;
    } else if (first.type === 'arrow') {
      fail(line, first, 'Expected a name before the arrow');
    } else if (second?.type === 'arrow') {
      const step = parseLink(tokens, line);
      if (step?.props.length) fail(line, step.tokens.props, 'Details belong on the link declaration, not on a flow step');
      else if (step) flow.steps.push(step);
    } else {
      fail(line, first, 'Only links go inside a flow, for example: web -> api: sends order');
    }
  };

  for (let line = 0; line < lines.length; line += 1) {
    const raw = lines[line];
    if (isSeparator(raw)) {
      model.markdownLine = line;
      model.diagramEnd = line;
      model.markdown = lines.slice(line + 1).join('\n');
      break;
    }
    const { tokens, problems } = tokenizeLine(raw);
    for (const problem of problems) {
      model.errors.push({ line, ...problem });
    }
    if (tokens.length === 0) continue;

    const [first, second] = tokens;
    if (flow) {
      parseFlowLine(tokens, line);
    } else if (first.type === 'rbrace') {
      if (stack.length === 0) {
        fail(line, first, 'This "}" does not close any group');
      } else {
        const closing = stack.pop();
        closing.endLine = line;
        closing.closed = true;
        closing.tokens.close = first;
        model.lineIndex.set(line, { type: 'group', id: closing.id });
        if (second) fail(line, second, 'Unexpected text after "}"');
      }
    } else if (first.type === 'arrow' || second?.type === 'arrow') {
      if (first.type === 'arrow') fail(line, first, 'Expected a name before the arrow');
      else {
        const edge = parseLink(tokens, line);
        if (edge) pendingEdges.push(edge);
      }
    } else if (first.type !== 'word') {
      fail(line, first, 'Expected a declaration');
    } else if (first.value === 'direction') {
      if (second?.type === 'word' && (second.value === 'right' || second.value === 'down') && !tokens[2]) {
        model.direction = second.value;
        model.directionLine = line;
        model.directionToken = second;
      } else {
        fail(line, second ?? first, 'Direction must be "right" or "down"');
      }
    } else if (first.value === 'group') {
      parseGroup(tokens, line);
    } else if (first.value === 'flow') {
      parseFlow(tokens, line);
    } else if (first.value === 'note') {
      parseNote(tokens, line);
    } else {
      parseNode(tokens, line);
    }
  }

  nameGroups();
  const lastLine = model.diagramEnd - 1;
  for (const group of stack) {
    group.endLine = lastLine;
    fail(group.line, group.tokens.open, `Group "${group.id}" is never closed`);
  }
  if (flow) {
    flow.endLine = lastLine;
    fail(flow.line, flow.tokens.open, `Flow "${flow.id}" is never closed`);
  }

  const checkEnds = (item) => {
    let valid = true;
    for (const end of ['from', 'to']) {
      const id = item[end];
      if (model.groupById.has(id)) {
        fail(item.line, item.tokens[end], `"${id}" is a group. Link to a component inside it`);
        valid = false;
      } else if (!model.nodeById.has(id)) {
        fail(item.line, item.tokens[end], `Unknown component "${id}"`);
        valid = false;
      }
    }
    return valid;
  };

  const seen = new Map();
  for (const edge of pendingEdges) {
    if (!checkEnds(edge)) continue;
    const base = `${edge.from}${edge.op}${edge.to}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    edge.key = count === 1 ? base : `${base}#${count}`;
    model.edges.push(edge);
    model.edgeByKey.set(edge.key, edge);
    model.lineIndex.set(edge.line, { type: 'edge', key: edge.key });
  }

  const notesPerTarget = new Map();
  for (const note of pendingNotes) {
    if (model.groupById.has(note.target)) {
      fail(note.line, note.tokens.target, 'Notes attach to components, not groups');
      continue;
    }
    if (!model.nodeById.has(note.target)) {
      fail(note.line, note.tokens.target, `Unknown component "${note.target}"`);
      continue;
    }
    const n = (notesPerTarget.get(note.target) ?? 0) + 1;
    notesPerTarget.set(note.target, n);
    note.key = `note:${note.target}:${n}`;
    model.notes.push(note);
    model.noteByKey.set(note.key, note);
    model.lineIndex.set(note.line, { type: 'note', key: note.key });
  }

  // A step walks an existing link. Connections are two-way, so a step may
  // also cross one against its declared direction.
  for (const { steps } of model.flows) {
    for (const step of steps) {
      if (!checkEnds(step)) continue;
      const forward = model.edges.filter((e) => e.from === step.from && e.to === step.to);
      const edge =
        forward.find((e) => e.op === step.op) ??
        forward[0] ??
        model.edges.find((e) => e.op === '<->' && e.from === step.to && e.to === step.from);
      if (!edge) {
        const reverse = model.edges.some((e) => e.from === step.to && e.to === step.from);
        fail(
          step.line,
          step.tokens.arrow,
          reverse
            ? `The link goes from ${step.to} to ${step.from}, not the other way`
            : `No link from ${step.from} to ${step.to}. Flows walk links declared above`,
        );
        continue;
      }
      step.edgeKey = edge.key;
      step.reversed = edge.from !== step.from;
      model.lineIndex.set(step.line, { type: 'edge', key: edge.key });
    }
  }

  model.errors.sort((a, b) => a.line - b.line || a.start - b.start);
  return model;
}

// The flow whose block contains `line`, if any.
export function flowAtLine(model, line) {
  return model.flows.find((flow) => line >= flow.line && line <= flow.endLine) ?? null;
}
