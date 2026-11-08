// Shapes of the data that crosses module boundaries, for the JSDoc types in the
// plain JavaScript modules (packages/core, packages/ui, apps/obsidian/src).
// Nothing here is compiled or bundled: TypeScript only reads it for the lint's
// type information (see tsconfig.json). Each shape is written as the code
// builds it; the module named in each comment is the one that does.
//
// From packages/core and packages/ui:   import('../types').Name
// From apps/obsidian/src:               import('../../../packages/types').Name

// ------------------------------------------------------------------ kinds.js

/** A component type a diagram can declare, as KIND_NAMES lists them (aliases resolve to these). */
export type KindName =
  | 'client'
  | 'mobile'
  | 'user'
  | 'dns'
  | 'cdn'
  | 'lb'
  | 'gateway'
  | 'ratelimiter'
  | 'service'
  | 'worker'
  | 'function'
  | 'cron'
  | 'db'
  | 'cache'
  | 'storage'
  | 'search'
  | 'warehouse'
  | 'coordinator'
  | 'queue'
  | 'topic'
  | 'stream'
  | 'external';

/** The colour family of a kind, and what decides a new link's default operator. */
export type KindCategory = 'edge' | 'compute' | 'data' | 'messaging' | 'external';

/** One entry of KINDS. */
export interface KindInfo {
  name: KindName;
  label: string;
  category: KindCategory;
}

/** A link operator as the model stores it ("=>" is read as "-->"). */
export type LinkOp = '->' | '-->' | '<->';

/** An arrow as written in the source: a LinkOp, or the legacy "=>". */
export type ArrowText = LinkOp | '=>';

/** One entry of OPS. */
export interface OpInfo {
  name: 'request' | 'event' | 'connection';
  label: string;
  hint: string;
}

// ----------------------------------------------------------------- parser.js

/** A character range within one source line: [start, end). */
export interface TextRange {
  start: number;
  end: number;
}

/** A name, a keyword or a count ("x3", "xN"). */
export interface WordToken extends TextRange {
  type: 'word';
  value: string;
}

/** A quoted string; `value` is unescaped, `closed` is false when the closing quote is missing. */
export interface StringToken extends TextRange {
  type: 'string';
  value: string;
  closed: boolean;
}

/** An unquoted link label: the text after ":" up to a comment or trailing "[details]". */
export interface TextToken extends TextRange {
  type: 'text';
  value: string;
}

/** "[detail, detail]"; `value` is the text between the brackets, `closed` is false when "]" is missing. */
export interface PropsToken extends TextRange {
  type: 'props';
  value: string;
  closed: boolean;
}

/** An arrow; `value` is the operator it stands for, `raw` what was written. */
export interface ArrowToken extends TextRange {
  type: 'arrow';
  value: LinkOp;
  raw: ArrowText;
}

export interface ColonToken extends TextRange {
  type: 'colon';
  value: ':';
}

export interface LbraceToken extends TextRange {
  type: 'lbrace';
  value: '{';
}

export interface RbraceToken extends TextRange {
  type: 'rbrace';
  value: '}';
}

/** What tokenizeLine() splits a line into. */
export type Token = WordToken | StringToken | TextToken | PropsToken | ArrowToken | ColonToken | LbraceToken | RbraceToken;

/** A problem tokenizeLine() found on its line. */
export interface LineProblem extends TextRange {
  message: string;
}

/** tokenizeLine()'s result. `comment` is the "#" or "//" comment's range, or null. */
export interface TokenizedLine {
  tokens: Token[];
  comment: TextRange | null;
  problems: LineProblem[];
}

/** An entry of Model.errors: a problem, and the line it is on. Problems never throw. */
export interface ParseError extends LineProblem {
  line: number;
}

/** The flow axis: "direction right" (the default) or "direction down". */
export type Direction = 'right' | 'down';

/** Where a component's tokens are on its line. */
export interface NodeTokens {
  kind: WordToken;
  id: WordToken;
  label: StringToken | null;
  count: WordToken | null;
  props: PropsToken | null;
}

/** A component: `<kind> <id> ["Label"] [x3|xN] [[detail, detail]]`. */
export interface DiagramNode {
  id: string;
  kind: KindName;
  /** The quoted label, or the id when there is none. */
  label: string;
  /** The id of the innermost group it is declared in, or null at the top level. */
  group: string | null;
  /** "x3" is 3, "xN" is 'N'; no count (or x1) is null. */
  count: number | 'N' | null;
  props: string[];
  line: number;
  tokens: NodeTokens;
}

/** Where a group's (or a flow's) tokens are on its lines. `close` is set once the "}" is found. */
export interface GroupTokens {
  /** The "group" keyword. */
  group: WordToken;
  id: WordToken | null;
  label: StringToken | null;
  open: LbraceToken;
  close?: RbraceToken;
}

/**
 * A component as a member of a group. It has none of a group's own fields:
 * the code tells members apart by reading `members` and `endLine`, which a
 * component does not have (they read as undefined).
 */
export interface MemberNode extends DiagramNode {
  members?: undefined;
  endLine?: undefined;
  parent?: undefined;
}

/**
 * A group as a member of a group. It has no `group` field (a component's
 * enclosing group): that one is `parent` on a group, and reads as undefined.
 */
export interface MemberGroup extends DiagramGroup {
  group?: undefined;
}

/**
 * What a group contains, in declaration order: components and groups. Each
 * side declares the other's own fields as undefined, so that either can be
 * read (or written) after a check such as `if (member.members)`, which does
 * not narrow the union without strictNullChecks.
 */
export type GroupMember = MemberNode | MemberGroup;

/** A group: `group [id] ["Title"] { ... }`. A title-only group's id is the title's slug. */
export interface DiagramGroup {
  id: string;
  label: string;
  /** The id of the enclosing group, or null at the top level. */
  parent: string | null;
  line: number;
  /** The line of its "}"; for an unclosed group, the last line of the diagram. */
  endLine: number;
  closed: boolean;
  members: GroupMember[];
  tokens: GroupTokens;
}

/** Where a link's (or a flow step's) tokens are on its line. */
export interface LinkTokens {
  from: WordToken;
  arrow: ArrowToken;
  to: WordToken;
  colon: ColonToken | null;
  label: TextToken | StringToken | null;
  props: PropsToken | null;
}

/** What parser.js reads from `<from> <arrow> <to>[: label] [[details]]`: a link declaration or a flow step. */
export interface LinkLine {
  from: string;
  to: string;
  op: LinkOp;
  /** The label text, or '' when there is none. */
  label: string;
  props: string[];
  line: number;
  tokens: LinkTokens;
}

/** A declared link. Its key is `${from}${op}${to}`, with `#2`, `#3`... for repeats of the same three. */
export interface DiagramEdge extends LinkLine {
  key: string;
}

/** A sticky note: `note <component> "text"`. Its key is `note:${target}:${n}`. */
export interface DiagramNote {
  /** The id of the component it is on. */
  target: string;
  text: string;
  line: number;
  tokens: NoteTokens;
  key: string;
}

export interface NoteTokens {
  /** The "note" keyword. */
  keyword: WordToken;
  target: WordToken;
  text: StringToken;
}

/** A line of a flow. `edgeKey` and `reversed` are set when it walks a declared link (see walkable()). */
export interface FlowStep extends LinkLine {
  /** The key of the link it walks. */
  edgeKey?: string;
  /** True when it walks a two-way connection against its declared direction. */
  reversed?: boolean;
}

/** Where a flow's tokens are on its lines. `close` is set once the "}" is found. */
export interface FlowTokens {
  /** The "flow" keyword. */
  flow: WordToken;
  id: WordToken | null;
  label: StringToken | null;
  open: LbraceToken;
  close?: RbraceToken;
}

/** A numbered walkthrough: `flow [id] ["Title"] { <from> -> <to>[: what happens] ... }`. */
export interface DiagramFlow {
  id: string;
  label: string;
  line: number;
  /** The line of its "}"; for an unclosed flow, the last line of the diagram. */
  endLine: number;
  closed: boolean;
  steps: FlowStep[];
  tokens: FlowTokens;
}

/** parse()'s result: the diagram declared by a text, with every item's place in the source. */
export interface Model {
  text: string;
  /** `text` split on "\n". */
  lines: string[];
  direction: Direction;
  /** The line of the "direction" declaration, or -1. */
  directionLine: number;
  /** Its "right" / "down" word, or null. */
  directionToken: WordToken | null;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  notes: DiagramNote[];
  flows: DiagramFlow[];
  /** Sorted by line, then start. */
  errors: ParseError[];
  nodeById: Map<string, DiagramNode>;
  groupById: Map<string, DiagramGroup>;
  edgeByKey: Map<string, DiagramEdge>;
  noteByKey: Map<string, DiagramNote>;
  flowById: Map<string, DiagramFlow>;
  /** What each line declares (a group: its first and its "}" line; a flow step: the link it walks). */
  lineIndex: Map<number, Selection>;
  /** The line of the "---" that starts the markdown section, or -1. */
  markdownLine: number;
  /** The first line that is not diagram source: the separator, or lines.length. */
  diagramEnd: number;
  /** Everything after the "---" line ('' when there is none). */
  markdown: string;
}

// ------------------------------------------------------------------- diff.js

/** How an item of the newer version compares with the older one. */
export type DiffStatus = 'same' | 'added' | 'removed' | 'changed';

export interface DiffCounts {
  added: number;
  removed: number;
  changed: number;
}

/** What changed between two versions, per kind of item. */
export interface DiffSummary {
  nodes: DiffCounts;
  edges: DiffCounts;
  groups: DiffCounts;
  notes: DiffCounts;
  flows: DiffCounts;
  markdownChanged: boolean;
  directionChanged: boolean;
}

/** A component in unionModel(). A removed one is a ghost at line + 0.5; `caption` says what changed. */
export interface DiffNode extends DiagramNode {
  status: DiffStatus;
  caption?: string;
}

/** A link in unionModel(). A removed one's key is `~${key}`; `displayLabel` adds what changed to the label. */
export interface DiffEdge extends DiagramEdge {
  status: DiffStatus;
  displayLabel?: string;
}

/** A group in unionModel(). A removed one is a ghost at line + 0.5. */
export interface DiffGroup extends DiagramGroup {
  status: DiffStatus;
}

/** A note in unionModel(). A removed one's key is `~${key}`, its line + 0.5. */
export interface DiffNote extends DiagramNote {
  status: DiffStatus;
}

/** unionModel(before, after): everything in `after`, plus ghosts of what only `before` had. */
export interface UnionModel {
  direction: Direction;
  nodes: DiffNode[];
  groups: DiffGroup[];
  edges: DiffEdge[];
  notes: DiffNote[];
  /** `after`'s flows, unchanged. */
  flows: DiagramFlow[];
  markdown: string;
  nodeById: Map<string, DiffNode>;
  groupById: Map<string, DiffGroup>;
  edgeByKey: Map<string, DiffEdge>;
  noteByKey: Map<string, DiffNote>;
  summary: DiffSummary;
}

// ------------------------------------------------------------------ flows.js

/** Whether an item takes part in the flow being walked through ('out' is drawn dimmed). */
export type FlowMembership = 'in' | 'out';

export interface FlowNode extends DiagramNode {
  flow: FlowMembership;
}

export interface FlowNote extends DiagramNote {
  flow: FlowMembership;
}

/** A link the flow does not walk. */
export interface FlowEdgeOut extends DiagramEdge {
  flow: 'out';
}

/** A link the flow walks: its step numbers, and the steps' texts (or its own label) as `displayLabel`. */
export interface FlowEdgeIn extends DiagramEdge {
  flow: 'in';
  steps: number[];
  displayLabel: string;
}

export type FlowEdge = FlowEdgeOut | FlowEdgeIn;

/** flowView(model, flowId): the parsed model with every node, link and note tagged in or out of the flow. */
export interface FlowViewModel extends Model {
  nodes: FlowNode[];
  edges: FlowEdge[];
  notes: FlowNote[];
  nodeById: Map<string, FlowNode>;
  edgeByKey: Map<string, FlowEdge>;
  noteByKey: Map<string, FlowNote>;
  /** The flow being walked through. */
  flow: DiagramFlow;
}

// ------------------------------------------------ what gets laid out and drawn

/** A component as drawn: parsed, or tagged by unionModel() (status, caption) or flowView() (flow). */
export interface RenderNode extends DiagramNode {
  status?: DiffStatus;
  caption?: string;
  flow?: FlowMembership;
}

/** A link as drawn: parsed, or tagged by unionModel() (status, displayLabel) or flowView() (flow, steps, displayLabel). */
export interface RenderEdge extends DiagramEdge {
  status?: DiffStatus;
  displayLabel?: string;
  flow?: FlowMembership;
  steps?: number[];
}

/** A group as drawn: parsed, or tagged by unionModel(). */
export interface RenderGroup extends DiagramGroup {
  status?: DiffStatus;
}

/** A note as drawn: parsed, or tagged by unionModel() or flowView(). */
export interface RenderNote extends DiagramNote {
  status?: DiffStatus;
  flow?: FlowMembership;
}

/**
 * What layoutDiagram() lays out, the renderer draws and the editor shows
 * (DiagramEditor.renderModel): a Model, a UnionModel or a FlowViewModel.
 */
export interface RenderModel {
  direction: Direction;
  nodes: RenderNode[];
  edges: RenderEdge[];
  groups: RenderGroup[];
  notes: RenderNote[];
  nodeById: Map<string, RenderNode>;
  groupById: Map<string, RenderGroup>;
  edgeByKey: Map<string, RenderEdge>;
  noteByKey: Map<string, RenderNote>;
}

// ----------------------------------------------------------------- layout.js

/** The text styles layout.js measures (each has its font in measure.js and styles.css). */
export type TextStyle = 'label' | 'caption' | 'edge' | 'title' | 'prop' | 'note' | 'count' | 'edgeProp' | 'badge';

/** The width of `text` drawn in `style`: measure.js createMeasurer(), or layout.js estimateTextWidth(). */
export type TextMeasurer = (text: string, style: TextStyle) => number;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** routing.js: the router's spacing, ROUTING_DEFAULTS. */
export interface RoutingOptions {
  clearance: number;
  stub: number;
  portInset: number;
  portSpacing: number;
  channel: number;
  margin: number;
}

/**
 * layoutDiagram()'s options besides its spacing constants (layout.js
 * DEFAULTS, which can be overridden too).
 */
export interface LayoutOptions {
  /** Text widths; estimateTextWidth() when absent. */
  measureText?: TextMeasurer;
  /** Passed to routeEdges(). */
  routing?: Partial<RoutingOptions>;
}

/** One sticky in a component's column of notes, before it is placed (`y` from the column's top). */
export interface NoteBlockItem {
  note: RenderNote;
  lines: string[];
  y: number;
  h: number;
}

/** A component's notes wrapped into a column of stickies, before it is placed. */
export interface NoteBlock {
  w: number;
  h: number;
  items: NoteBlockItem[];
}

/** A component's card: where it is and its fitted texts (`stack` is the offset of the "x3" look). */
export interface NodeBox extends Rect {
  id: string;
  labelText: string;
  captionText: string;
  propLines: string[];
  /** "×3", or null. */
  countText: string | null;
  countWidth: number;
  stack: number;
  notes: NoteBlock | null;
}

/** A group's box; `depth` is its nesting depth (0 at the top level). */
export interface GroupBox extends Rect {
  id: string;
  depth: number;
  titleRect: Rect;
}

/** A link label's box: the label, its details line, and the flow's step badge. */
export interface EdgeLabelBox extends Rect {
  text: string;
  propsText: string;
  badge: string;
  badgeW: number;
}

/** A link's route (an orthogonal polyline) and its label's box, or null. */
export interface EdgeLayout {
  key: string;
  points: Point[] | undefined;
  label: EdgeLabelBox | null;
}

/** One placed sticky note. */
export interface NoteItemBox extends Rect {
  key: string;
  line: number;
  status: DiffStatus | undefined;
  flow: FlowMembership | undefined;
  lines: string[];
}

/** The placed column of a component's notes, and the dotted tie from the card to it. */
export interface NoteColumn extends Rect {
  /** The component's id. */
  target: string;
  tie: [Point, Point];
  items: NoteItemBox[];
}

/** layoutDiagram()'s result. Maps are keyed by node id, group id, edge key and target node id. */
export interface Layout {
  horizontal: boolean;
  nodes: Map<string, NodeBox>;
  groups: Map<string, GroupBox>;
  edges: Map<string, EdgeLayout>;
  notes: Map<string, NoteColumn>;
  /** Everything drawn; all zero for an empty diagram. */
  bounds: Rect;
}

// ---------------------------------------------------------------- routing.js

/** routeEdges()'s input. `ancestorsOf(nodeId)` returns the ids of the groups containing that node. */
export interface RouteInput {
  rects: Map<string, Rect>;
  groups: GroupBox[];
  edges: ReadonlyArray<Pick<DiagramEdge, 'key' | 'from' | 'to'>>;
  ancestorsOf: (nodeId: string) => string[];
  horizontal: boolean;
}

// ------------------------------------------------- edits.js, the selection

// Components and groups are known by id, links and notes by key. A ref has
// only its own field: the other one (`key` on a node or group, `id` on a link
// or note) is absent, and the code reads it from any ref to get undefined.

export interface NodeRef {
  type: 'node';
  id: string;
  key?: undefined;
}

export interface GroupRef {
  type: 'group';
  id: string;
  key?: undefined;
}

export interface EdgeRef {
  type: 'edge';
  key: string;
  id?: undefined;
}

export interface NoteRef {
  type: 'note';
  key: string;
  id?: undefined;
}

/**
 * A diagram item by identity: what is selected (DiagramEditor.selection),
 * what an edit selects afterwards, what DiagramRenderer.hit() finds, and what
 * a source line declares (Model.lineIndex).
 */
export type Selection = NodeRef | GroupRef | EdgeRef | NoteRef;

/** What every edit in edits.js returns: the new text, and what to select afterwards. */
export interface EditResult {
  text: string;
  select: Selection | null;
}

/** ensureMarkdown()'s result: the text, and the line the caret should go to. */
export interface CaretEdit {
  text: string;
  line: number;
}

/** addNode()'s options; `group` is the id of the group to add into, null for the top level. */
export interface NewNode {
  kind: string;
  label?: string;
  group?: string | null;
}

/** addGroup()'s options; `parent` is the id of the group to add into, null for the top level. */
export interface NewGroup {
  label?: string;
  parent?: string | null;
}

/** addEdge()'s options. */
export interface NewEdge {
  from: string;
  to: string;
  op?: LinkOp;
  label?: string;
}

// --------------------------------------------------------------- document.js

/** A saved version of the diagram. */
export interface Snapshot {
  id: string;
  name: string;
  text: string;
  /** An ISO date. */
  createdAt: string;
}

/**
 * The editor's document: `text` is the diagram source, then a "---" line and
 * the notes when there are any; `snapshots` are the saved versions, oldest first.
 */
export interface DiagramDocument {
  text: string;
  snapshots: Snapshot[];
}

/**
 * Everything around the diagram in the note it was read from, kept by
 * parseNote() so that serializeNote() can write the note back as it was.
 * newEnvelope() and slimEnvelope() leave out `blockLine` and the copies.
 */
export interface Envelope {
  /** A byte order mark, or ''. */
  bom: string;
  eol: '\n' | '\r\n';
  /** The frontmatter's lines, its "---" lines included, or null. */
  frontmatter: string[] | null;
  /** The lines between the frontmatter and the diagram's block. */
  prefix: string[];
  /** The block's opening fence ("```", "~~~~"...), or null. */
  fence: string | null;
  indent: string;
  hasBlock: boolean;
  /** The line of the opening fence (from the top of the note), or -1. */
  blockLine?: number;
  /** The editor text the note was read as, to give the note back unchanged. */
  text: string | null;
  /** The versions comment as written, kept while the versions are the same. */
  versionLines: string[] | null;
  snapshotKey: string | null;
  /** The note as read. */
  original: string | null;
}

/** parseNote()'s result. */
export interface ParsedNote {
  doc: DiagramDocument;
  envelope: Envelope;
}

/** readDiagramFile()'s result: `envelope` is null for the formats that are not notes. */
export interface OpenedFile {
  doc: DiagramDocument;
  envelope: Envelope | null;
}

// ------------------------------------------------------------------ editor.js

/**
 * What hosts the editor (the web page, an Obsidian view). Only load and save
 * are required.
 */
export interface EditorHost {
  load(): Promise<DiagramDocument>;
  /**
   * Writes the document. The editor calls it and moves on, without waiting
   * for it or looking at what it returns: a host that writes asynchronously
   * starts the write and handles its errors itself.
   */
  save(doc: DiagramDocument): void;
  /** Renders the notes (Obsidian has its own renderer); markdown.js otherwise. Called on its own, not as a method. */
  renderMarkdown?: (markdown: string, element: HTMLElement) => void;
  /** Where exports go; a download otherwise. */
  saveFile?(filename: string, blob: Blob): void | Promise<void>;
  /** The base name for exports. */
  fileName?(): string;
  /** Shows a short message; the editor's toast otherwise. */
  notify?(message: string, options: { error: boolean }): void;
  /** The document as a note; a new note otherwise. */
  serializeDocument?(doc: DiagramDocument): string;
  /** False where the note already is the file (Obsidian): no "export the document". */
  exportsDocument?: boolean;
  /** True to label shortcuts ⌘S rather than Ctrl+S. */
  appleKeys?: boolean;
}

/** The canvas's pan and zoom: a point p of the diagram is drawn at p * k + (tx, ty). */
export interface CanvasView {
  k: number;
  tx: number;
  ty: number;
}

/** What a host keeps per document so it opens again as it was left (DiagramEditor.getViewState()). */
export interface ViewState {
  /** null: fit the diagram to the canvas. */
  view: CanvasView | null;
  /** The source pane's width ("320px", "40%"), or null for the default. */
  codeWidth: string | null;
  sourceHidden: boolean;
  /** The notes panel the user opened (true) or closed (false); null: decided by the room. */
  notes: boolean | null;
}

/** What DiagramEditor.commit() takes: an EditResult, or new text that leaves the selection alone. */
export interface TextChange {
  text: string;
  select?: Selection | null;
}

/** Where a change comes from: the canvas (and the editor's own actions) or typing in the source. */
export type ChangeSource = 'canvas' | 'code';

/** Who opened a flow: the user (canvas, keys) or the caret entering its block in the source. */
export type FlowSource = 'user' | 'code';

/** An undo step: the text and the selection it had. `key` groups consecutive typing into one step. */
export interface HistoryEntry {
  text: string;
  selection: Selection | null;
  key: string | null;
  time: number;
}

// --------------------------------------------- code-pane.js, notes-panel.js...

/** What the source pane reports to the editor. */
export interface CodePaneHandlers {
  onInput: (value: string) => void;
  onCaretLine: (line: number) => void;
  onUndo: () => void;
  onRedo: () => void;
  onEscape: () => void;
}

/** CodePane.update()'s argument. `lineMarks` maps a line to extra classes (selection, diff status). */
export interface CodePaneState {
  text: string;
  model: Model;
  readOnly: boolean;
  lineMarks: Map<number, string>;
  banner: HTMLElement | null;
  onJump: (line: number, column: number) => void;
}

/** NotesPanel.update()'s argument. */
export interface NotesPanelState {
  markdown: string;
  open: boolean;
  /** Different from the version being compared. */
  changed: boolean;
  readOnly: boolean;
}

/** The timeline's open form: saving a new version, or renaming one. */
export type TimelineMode = { type: 'save' } | { type: 'rename'; id: string };

/** export.js diagramSvg()'s result: a self-contained SVG file and its size. */
export interface SvgImage {
  text: string;
  width: number;
  height: number;
}

// ------------------------------------------------------------------ canvas.js

/** Which end of a new link the anchor component is: 'out' links from it, 'in' links to it. */
export type LinkDirection = 'out' | 'in';

/** Link mode: linking from (or to) `anchor`; `target` is the component it would link to. */
export interface CanvasLink {
  anchor: string;
  dir: LinkDirection;
  target: string | null;
  /** Started by dragging a (+) handle. */
  viaDrag: boolean;
  /** Where the pointer is, in diagram coordinates. */
  pointer: Point | null;
}

/** Where a toolbar or handle sits against its anchor point. */
export type ChromeAlign = 'top' | 'bottom' | 'left' | 'right' | 'top-far' | 'bottom-far' | 'top-start';

/** Canvas.openAddForm()'s options. */
export interface AddFormOptions {
  /** The new component goes after (out) or before (in) the component `id`, linked to it. */
  link?: { id: string; dir: LinkDirection } | null;
  /** The group to add into (null: none); by default the linked component's group. */
  group?: string | null;
  /** The type preselected ('group' allowed when not linking). */
  kind?: string;
  /** Where to open the form, in canvas (screen) coordinates. */
  at?: Point;
}

// ------------------------------------------------------------------- dom.js

/** `on…` listeners by event name. Taken from a method, like DomListener, so a listener that types its event more narrowly fits. */
type DomEventHandlers = { [K in keyof HTMLElementEventMap as `on${K}`]?: { handler(event: HTMLElementEventMap[K]): void }['handler'] };

/** A listener for any event. Taken from a method, so a listener for a narrower event (MouseEvent...) fits it. */
type DomListener = { listener(event: Event): void }['listener'];

/** A value of el() / svg() props: an attribute or property, an `on…` listener, a `style` object. */
export type DomPropValue = string | number | boolean | null | undefined | DomListener | Partial<CSSStyleDeclaration>;

/**
 * el() / svg() props: attributes and properties by name (null, undefined and
 * false leave one out), `on…` listeners, `text` for the text content, `style`.
 */
export interface DomProps extends DomEventHandlers {
  [name: string]: DomPropValue;
}

/** A child for el() / svg(): a node, text, nothing (null, undefined, false), or nested lists of them. */
export type DomChild = Node | string | number | false | null | undefined | readonly DomChild[];

// ------------------------------------------------------- apps/obsidian/src

/** auto-open.js: what the user chose to open a note as, in one tab. */
export type OpenChoice = 'diagram' | 'markdown';

/** opensAsDiagram()'s question: a tab asked for a view of type `type` on the note at `path`. */
export interface OpenRequest {
  type: string | undefined;
  path: string | null;
  layoutReady: boolean;
  restoring?: boolean;
  choice: OpenChoice | undefined;
  flagged: boolean;
}

/** view-state.js: a note's view state and when it was last kept (ms since the epoch). */
export interface ViewStateEntry {
  state: ViewState;
  at: number;
}

/** view-state.js: ViewStateStore.toJSON(), as kept in the plugin's data, by note path. */
export interface StoredViewStates {
  version: number;
  notes: Record<string, ViewStateEntry>;
}

/** A view state as read back from data.json: any field may be missing or wrong (each is checked). */
export interface StoredViewState {
  view?: { k?: unknown; tx?: unknown; ty?: unknown } | null;
  codeWidth?: unknown;
  sourceHidden?: unknown;
  notes?: unknown;
}

/** What ViewStateStore is built from: the plugin data's view states as read back (an older shape, a hand edit...). */
export interface StoredViewStatesInput {
  version?: unknown;
  notes?: Record<string, { state?: StoredViewState | null; at?: unknown } | null> | null;
}

/** The plugin's data (data.json in its folder). */
export interface PluginData {
  viewState: StoredViewStates;
}

/**
 * main.js: the plugin's data as loadData() reads it back from data.json: what
 * was saved (PluginData), or an older shape, a hand edit (ViewStateStore checks
 * every view state).
 */
export interface StoredPluginData {
  viewState?: StoredViewStatesInput | null;
}

// Obsidian types Plugin.loadData() as Promise<any>, since each plugin keeps its
// own data. The one plugin here (main.js) reads back StoredPluginData, or null
// when there is no data.json yet. An overload declared in an augmentation comes
// before the class's own, so this.loadData() has this type.
declare module 'obsidian' {
  interface Plugin {
    loadData(): Promise<StoredPluginData | null>;
  }
}
