// Catalog of the component types a diagram can declare, and of the link
// operators. Categories drive the colour family in the UI and the default link
// semantics below.

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

export const KINDS = Object.fromEntries(
  DEFINITIONS.map(([name, label, category]) => [name, { name, label, category }]),
);

export const KIND_NAMES = DEFINITIONS.map(([name]) => name);

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

export function resolveKind(word) {
  if (Object.hasOwn(KINDS, word)) return word;
  return Object.hasOwn(ALIASES, word) ? ALIASES[word] : null;
}

// Link operators. "=>" is still read as an event so older documents keep
// working, but everything the editor writes uses "-->".
export const OPS = {
  '->': { name: 'request', label: 'Request', hint: 'request / response' },
  '-->': { name: 'event', label: 'Event', hint: 'event, asynchronous' },
  '<->': { name: 'connection', label: 'Connection', hint: 'open two-way connection (WebSocket, SSE, streaming)' },
};

export const OP_LIST = Object.keys(OPS);

export const LEGACY_OPS = { '=>': '-->' };

// Anything touching a broker is an event by default; everything else is a
// request. The canvas uses this to preselect the link type.
export function defaultLinkOp(fromKind, toKind) {
  const isMessaging = (kind) => KINDS[kind]?.category === 'messaging';
  return isMessaging(fromKind) || isMessaging(toKind) ? '-->' : '->';
}
