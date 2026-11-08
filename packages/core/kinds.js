// Catalog of the component types a diagram can declare, and of the link
// operators. Categories drive the colour family in the UI and the default link
// semantics below.

/** @typedef {import('../types').KindName} KindName */
/** @typedef {import('../types').KindCategory} KindCategory */
/** @typedef {import('../types').KindInfo} KindInfo */
/** @typedef {import('../types').LinkOp} LinkOp */
/** @typedef {import('../types').OpInfo} OpInfo */

/** @type {Array<[KindName, string, KindCategory]>} */
const DEFINITIONS = [
  ['client', 'Client', 'edge'],
  ['mobile', 'Mobile app', 'edge'],
  ['user', 'User', 'edge'],
  ['dns', 'DNS', 'edge'],
  ['cdn', 'CDN', 'edge'],
  ['lb', 'Load balancer', 'edge'],
  ['gateway', 'API gateway', 'edge'],
  ['ratelimiter', 'Rate limiter', 'edge'],
  ['service', 'Service', 'compute'],
  ['worker', 'Worker', 'compute'],
  ['function', 'Function', 'compute'],
  ['cron', 'Scheduler', 'compute'],
  ['db', 'Database', 'data'],
  ['cache', 'Cache', 'data'],
  ['storage', 'Object storage', 'data'],
  ['search', 'Search index', 'data'],
  ['warehouse', 'Data warehouse', 'data'],
  ['coordinator', 'Coordinator', 'data'],
  ['queue', 'Queue', 'messaging'],
  ['topic', 'Topic', 'messaging'],
  ['stream', 'Stream', 'messaging'],
  ['external', 'External system', 'external'],
];

/**
 * The kinds by name. Looked up with any word (an unknown one has no entry).
 * @type {Record<string, KindInfo>}
 */
export const KINDS = Object.fromEntries(
  DEFINITIONS.map(([name, label, category]) => [name, { name, label, category }]),
);

/** @type {KindName[]} */
export const KIND_NAMES = DEFINITIONS.map(([name]) => name);

/**
 * Other words for a kind, and the kind each stands for.
 * @type {Record<string, KindName>}
 */
const ALIASES = {
  database: 'db',
  bucket: 'storage',
  consumer: 'worker',
  lambda: 'function',
  browser: 'client',
  scheduler: 'cron',
  loadbalancer: 'lb',
  thirdparty: 'external',
  ratelimit: 'ratelimiter',
  limiter: 'ratelimiter',
  olap: 'warehouse',
  datalake: 'warehouse',
  lake: 'warehouse',
  coordination: 'coordinator',
  consensus: 'coordinator',
};

/**
 * The kind a word names (a kind, or an alias of one), or null.
 * @param {string} word
 * @returns {KindName | null}
 */
export function resolveKind(word) {
  if (Object.hasOwn(KINDS, word)) return word;
  return Object.hasOwn(ALIASES, word) ? ALIASES[word] : null;
}

// Link operators. "=>" is still read as an event so older documents keep
// working, but everything the editor writes uses "-->".
/** @type {Record<LinkOp, OpInfo>} */
export const OPS = {
  '->': { name: 'request', label: 'Request', hint: 'request / response' },
  '-->': { name: 'event', label: 'Event', hint: 'event, asynchronous' },
  '<->': { name: 'connection', label: 'Connection', hint: 'open two-way connection (WebSocket, SSE, streaming)' },
};

/**
 * The operators, in the order the editor cycles through them.
 * @type {LinkOp[]}
 */
export const OP_LIST = Object.keys(OPS);

/**
 * Old spellings of an arrow, and the operator each stands for.
 * @type {Record<string, LinkOp>}
 */
export const LEGACY_OPS = { '=>': '-->' };

// Anything touching a broker is an event by default; everything else is a
// request. The canvas uses this to preselect the link type.
/**
 * @param {string} fromKind
 * @param {string} toKind
 * @returns {LinkOp}
 */
export function defaultLinkOp(fromKind, toKind) {
  /**
   * @param {string} kind
   * @returns {boolean}
   */
  const isMessaging = (kind) => KINDS[kind]?.category === 'messaging';
  return isMessaging(fromKind) || isMessaging(toKind) ? '-->' : '->';
}
