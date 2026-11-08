// Orthogonal edge router. Links are routed one at a time with A* over a sparse
// grid built from the geometry of the diagram. Node rectangles are hard obstacles,
// so a link can never run through a component whatever the layout decides.
// Bends, crossings, overlapping another link and cutting through an unrelated
// group are costs, so the search prefers clean routes without being forbidden
// from taking an ugly one when nothing else exists.

/** @typedef {import('../types').Point} Point */
/** @typedef {import('../types').Rect} Rect */
/** @typedef {import('../types').GroupBox} GroupBox */
/** @typedef {import('../types').RouteInput} RouteInput */
/** @typedef {import('../types').RoutingOptions} RoutingOptions */

const E = 0;
const S = 1;
const W = 2;
const N = 3;
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/**
 * E, S, W or N: a side of a component, or a direction of travel (an index into
 * DX and DY).
 * @typedef {0 | 1 | 2 | 3} Side
 */

const COST = {
  bend: 22,
  cross: 36,
  overlapFlat: 30,
  overlapPerPx: 3,
  foreignGroupPerPx: 1.4,
  groupTitlePerPx: 6,
};

/** @type {RoutingOptions} */
export const ROUTING_DEFAULTS = {
  clearance: 10,
  stub: 14,
  portInset: 10,
  portSpacing: 14,
  channel: 14,
  margin: 40,
};

class MinHeap {
  constructor() {
    /** @type {number[]} */ this.keys = [];
    /** @type {number[]} */ this.values = [];
  }

  clear() {
    this.keys.length = 0;
    this.values.length = 0;
  }

  get size() {
    return this.keys.length;
  }

  push(/** @type {number} */ key, /** @type {number} */ value) {
    const { keys, values } = this;
    let i = keys.length;
    keys.push(key);
    values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (keys[parent] <= key) break;
      keys[i] = keys[parent];
      values[i] = values[parent];
      i = parent;
    }
    keys[i] = key;
    values[i] = value;
  }

  // Returns the smallest value and leaves its key in `lastKey`.
  pop() {
    const { keys, values } = this;
    const value = values[0];
    /** @type {number} */ this.lastKey = keys[0];
    const key = keys.pop();
    const val = values.pop();
    const n = keys.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= n) break;
        if (child + 1 < n && keys[child + 1] < keys[child]) child += 1;
        if (keys[child] >= key) break;
        keys[i] = keys[child];
        values[i] = values[child];
        i = child;
      }
      keys[i] = key;
      values[i] = val;
    }
    return value;
  }
}

/**
 * The side of `a` a link leaves by and the side of `b` it enters by.
 * @param {Rect} a
 * @param {Rect} b
 * @param {boolean} horizontal
 * @returns {[Side, Side]}
 */
function chooseSides(a, b, horizontal) {
  const right = b.x >= a.x + a.w;
  const left = b.x + b.w <= a.x;
  const below = b.y >= a.y + a.h;
  const above = b.y + b.h <= a.y;
  if (horizontal) {
    if (right) return [E, W];
    if (left) return [W, E];
    if (below) return [S, N];
    if (above) return [N, S];
  } else {
    if (below) return [S, N];
    if (above) return [N, S];
    if (right) return [E, W];
    if (left) return [W, E];
  }
  return [E, W];
}

/**
 * @param {Side} side
 * @returns {boolean}
 */
const isVerticalSide = (side) => side === E || side === W;

/**
 * The point at `along` on one side of `rect` (a y on the east and west sides,
 * an x on the others).
 * @param {Rect} rect
 * @param {Side} side
 * @param {number} along
 * @returns {Point}
 */
function sidePoint(rect, side, along) {
  switch (side) {
    case E:
      return { x: rect.x + rect.w, y: along };
    case W:
      return { x: rect.x, y: along };
    case S:
      return { x: along, y: rect.y + rect.h };
    default:
      return { x: along, y: rect.y };
  }
}

/**
 * The middle of one side of `rect`, as a coordinate along that side.
 * @param {Rect} rect
 * @param {Side} side
 * @returns {number}
 */
const centerAlong = (rect, side) => {
  return isVerticalSide(side) ? rect.y + rect.h / 2 : rect.x + rect.w / 2;
};

/**
 * A link between two different components. routeEdges() plans which side of
 * each component it leaves and enters, its place among the links (`index`,
 * which breaks ties) and how far apart the two centers are (`distance`: short
 * links are routed first). assignPorts() adds the rest: where along each side
 * it attaches and how many link ends share that side, its end points on the
 * components, and the stubs just off them where the search starts and ends.
 * @typedef {{
 *   key: string,
 *   from: string,
 *   to: string,
 *   index: number,
 *   sourceSide: Side,
 *   targetSide: Side,
 *   distance: number,
 *   sourceAlong?: number,
 *   sourceCount?: number,
 *   targetAlong?: number,
 *   targetCount?: number,
 *   start?: Point,
 *   end?: Point,
 *   startStub?: Point,
 *   endStub?: Point,
 * }} RoutePlan
 */

/**
 * One end of a link on a side of a component, while ports are assigned.
 * @typedef {{ plan: RoutePlan, end: 'source' | 'target' }} PortEntry
 */

// Spreads links arriving on the same side of a node, ordered by where each one
// is going so they do not cross right at the node.
/**
 * @param {RoutePlan[]} plans
 * @param {Map<string, Rect>} rects
 * @param {RoutingOptions} cfg
 */
function assignPorts(plans, rects, cfg) {
  /** @type {Map<string, { id: string, side: Side, entries: PortEntry[] }>} */
  const sides = new Map();
  /**
   * @param {string} id
   * @param {Side} side
   * @param {RoutePlan} plan
   * @param {'source' | 'target'} end
   */
  const register = (id, side, plan, end) => {
    const key = `${id}:${side}`;
    if (!sides.has(key)) sides.set(key, { id, side, entries: [] });
    sides.get(key).entries.push({ plan, end });
  };
  for (const plan of plans) {
    register(plan.from, plan.sourceSide, plan, 'source');
    register(plan.to, plan.targetSide, plan, 'target');
  }

  for (const { id, side, entries } of sides.values()) {
    const rect = rects.get(id);
    const otherCenter = (/** @type {PortEntry} */ { plan, end }) => {
      return centerAlong(rects.get(end === 'source' ? plan.to : plan.from), side);
    };
    entries.sort((a, b) => otherCenter(a) - otherCenter(b) || a.plan.index - b.plan.index);

    const length = isVerticalSide(side) ? rect.h : rect.w;
    const usable = length - 2 * cfg.portInset;
    const count = entries.length;
    const spacing = count > 1 ? Math.min(cfg.portSpacing, usable / (count - 1)) : 0;
    const first = centerAlong(rect, side) - (spacing * (count - 1)) / 2;
    entries.forEach(({ plan, end }, i) => {
      const along = Math.round(first + spacing * i);
      if (end === 'source') {
        plan.sourceAlong = along;
        plan.sourceCount = count;
      } else {
        plan.targetAlong = along;
        plan.targetCount = count;
      }
    });
  }

  // Straighten a link whose ends face each other when one end has freedom to
  // move. Prevents tiny jogs between almost-aligned nodes.
  for (const plan of plans) {
    if ((plan.sourceSide + 2) % 4 !== plan.targetSide) continue;
    const a = rects.get(plan.from);
    const b = rects.get(plan.to);
    const vertical = isVerticalSide(plan.sourceSide);
    /**
     * @param {Rect} rect
     * @returns {[number, number]}
     */
    const range = (rect) => {
      const start = vertical ? rect.y : rect.x;
      const size = vertical ? rect.h : rect.w;
      return [start + cfg.portInset, start + size - cfg.portInset];
    };
    const [aLo, aHi] = range(a);
    const [bLo, bHi] = range(b);
    if (plan.sourceCount === 1 && plan.targetCount === 1) {
      const lo = Math.max(aLo, bLo);
      const hi = Math.min(aHi, bHi);
      if (lo <= hi) {
        const mid = (plan.sourceAlong + plan.targetAlong) / 2;
        const value = Math.round(Math.min(hi, Math.max(lo, mid)));
        plan.sourceAlong = value;
        plan.targetAlong = value;
      }
    } else if (plan.sourceCount === 1 && plan.targetAlong >= aLo && plan.targetAlong <= aHi) {
      plan.sourceAlong = plan.targetAlong;
    } else if (plan.targetCount === 1 && plan.sourceAlong >= bLo && plan.sourceAlong <= bHi) {
      plan.targetAlong = plan.sourceAlong;
    }
  }

  for (const plan of plans) {
    plan.start = sidePoint(rects.get(plan.from), plan.sourceSide, plan.sourceAlong);
    plan.end = sidePoint(rects.get(plan.to), plan.targetSide, plan.targetAlong);
    plan.startStub = {
      x: plan.start.x + DX[plan.sourceSide] * cfg.stub,
      y: plan.start.y + DY[plan.sourceSide] * cfg.stub,
    };
    plan.endStub = {
      x: plan.end.x + DX[plan.targetSide] * cfg.stub,
      y: plan.end.y + DY[plan.targetSide] * cfg.stub,
    };
  }
}

// Extra parallel channels inside gaps, so links can run side by side. Capped per
// gap: wide empty areas need a few lanes, not a dense mesh.
/**
 * @param {number[]} sorted
 * @param {number} spacing
 * @param {number} [maxLanes]
 * @returns {number[]}
 */
function fillLines(sorted, spacing, maxLanes = 6) {
  /** @type {number[]} */ const out = [];
  for (let i = 0; i < sorted.length; i += 1) {
    out.push(sorted[i]);
    const gap = sorted[i + 1] - sorted[i];
    if (gap > spacing * 1.5) {
      const parts = Math.min(maxLanes + 1, Math.floor(gap / spacing));
      for (let k = 1; k < parts; k += 1) out.push(Math.round(sorted[i] + (k * gap) / parts));
    }
  }
  return out;
}

/**
 * The index of the first of the sorted `values` that is not below `target`.
 * @param {number[]} values
 * @param {number} target
 * @returns {number}
 */
function lowerBound(values, target) {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The search space, and the search's scratch arrays. Grid lines run along every
 * component and group at the clearance, through every end point and stub, and
 * around everything at the margin, with extra lanes in wide gaps (`xs` and `ys`,
 * sorted). Vertex `ix + iy * nx` is where the lines at xs[ix] and ys[iy] meet.
 * The `block`, `group`, `title` and `used` arrays come in pairs: H for the step
 * from a vertex to the next one on the right, V for the step to the next one
 * below, both indexed by the step's first vertex. `block` is 1 where a component
 * is in the way, `group` has a bit for each of the first 31 groups the step runs
 * inside, `title` is 1 where it runs through a group's title, and `used` counts
 * the routed links already on it. `passH` and `passV` are per vertex: 1 where a
 * routed link already runs through it horizontally or vertically, or where a
 * stub is reserved. `gScore`, `parent`, `stamp` (the search that last set those
 * two) and `closed` (the search that expanded the state) are per search state,
 * `vertex * 4 + direction of travel`; `generation` numbers the searches, so
 * those arrays never need clearing, and `heap` is the open set.
 * @typedef {{
 *   xs: number[],
 *   ys: number[],
 *   nx: number,
 *   ny: number,
 *   blockH: Uint8Array,
 *   blockV: Uint8Array,
 *   groupH: Int32Array,
 *   groupV: Int32Array,
 *   titleH: Uint8Array,
 *   titleV: Uint8Array,
 *   usedH: Uint16Array,
 *   usedV: Uint16Array,
 *   passH: Uint8Array,
 *   passV: Uint8Array,
 *   gScore: Float64Array,
 *   stamp: Int32Array,
 *   closed: Int32Array,
 *   parent: Int32Array,
 *   generation: number,
 *   heap: MinHeap,
 * }} Grid
 */

/**
 * @param {Map<string, Rect>} rects
 * @param {GroupBox[]} groups
 * @param {RoutePlan[]} plans
 * @param {RoutingOptions} cfg
 * @returns {Grid}
 */
function buildGrid(rects, groups, plans, cfg) {
  /** @type {Set<number>} */ const xset = new Set();
  /** @type {Set<number>} */ const yset = new Set();
  const c = cfg.clearance;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (/** @type {Rect} */ r) => {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  };

  for (const r of rects.values()) {
    extend(r);
    xset.add(r.x - c).add(r.x + r.w + c);
    yset.add(r.y - c).add(r.y + r.h + c);
  }
  for (const g of groups) {
    extend(g);
    xset.add(g.x - c).add(g.x + g.w + c);
    yset.add(g.y - c).add(g.y + g.h + c);
  }
  for (const plan of plans) {
    for (const point of [plan.start, plan.end, plan.startStub, plan.endStub]) {
      xset.add(point.x);
      yset.add(point.y);
    }
  }
  xset.add(minX - cfg.margin).add(maxX + cfg.margin);
  yset.add(minY - cfg.margin).add(maxY + cfg.margin);

  const byNumber = (/** @type {number} */ a, /** @type {number} */ b) => a - b;
  const xs = fillLines([...xset].sort(byNumber), cfg.channel);
  const ys = fillLines([...yset].sort(byNumber), cfg.channel);
  const nx = xs.length;
  const ny = ys.length;
  const cells = nx * ny;

  const blockH = new Uint8Array(cells);
  const blockV = new Uint8Array(cells);
  for (const r of rects.values()) {
    const left = r.x - c;
    const right = r.x + r.w + c;
    const top = r.y - c;
    const bottom = r.y + r.h + c;
    const ix0 = lowerBound(xs, left);
    const ix1 = lowerBound(xs, right);
    const iy0 = lowerBound(ys, top);
    const iy1 = lowerBound(ys, bottom);
    for (let iy = iy0 + 1; iy < iy1; iy += 1) {
      for (let ix = ix0; ix < ix1; ix += 1) blockH[ix + iy * nx] = 1;
    }
    for (let ix = ix0 + 1; ix < ix1; ix += 1) {
      for (let iy = iy0; iy < iy1; iy += 1) blockV[ix + iy * nx] = 1;
    }
  }

  // Which groups (bit per group) and which group titles each step lies in, so
  // the per-link soft costs are a lookup instead of a scan.
  const groupH = new Int32Array(cells);
  const groupV = new Int32Array(cells);
  const titleH = new Uint8Array(cells);
  const titleV = new Uint8Array(cells);
  /**
   * @param {Rect} r
   * @param {number} bit
   * @param {Int32Array | Uint8Array} maskH
   * @param {Int32Array | Uint8Array} maskV
   */
  const paint = (r, bit, maskH, maskV) => {
    const ix0 = lowerBound(xs, r.x);
    const ix1 = lowerBound(xs, r.x + r.w);
    const iy0 = lowerBound(ys, r.y);
    const iy1 = lowerBound(ys, r.y + r.h);
    for (let iy = iy0; iy < ny && ys[iy] < r.y + r.h; iy += 1) {
      if (ys[iy] <= r.y) continue;
      for (let ix = Math.max(0, ix0 - 1); ix < ix1 && ix + 1 < nx; ix += 1) {
        const mid = (xs[ix] + xs[ix + 1]) / 2;
        if (mid > r.x && mid < r.x + r.w) maskH[ix + iy * nx] |= bit;
      }
    }
    for (let ix = ix0; ix < nx && xs[ix] < r.x + r.w; ix += 1) {
      if (xs[ix] <= r.x) continue;
      for (let iy = Math.max(0, iy0 - 1); iy < iy1 && iy + 1 < ny; iy += 1) {
        const mid = (ys[iy] + ys[iy + 1]) / 2;
        if (mid > r.y && mid < r.y + r.h) maskV[ix + iy * nx] |= bit;
      }
    }
  };
  groups.forEach((g, i) => {
    if (i < 31) paint(g, 1 << i, groupH, groupV);
    paint(g.titleRect, 1, titleH, titleV);
  });

  return {
    xs,
    ys,
    nx,
    ny,
    blockH,
    blockV,
    groupH,
    groupV,
    titleH,
    titleV,
    usedH: new Uint16Array(cells),
    usedV: new Uint16Array(cells),
    passH: new Uint8Array(cells),
    passV: new Uint8Array(cells),
    gScore: new Float64Array(cells * 4),
    stamp: new Int32Array(cells * 4),
    closed: new Int32Array(cells * 4),
    parent: new Int32Array(cells * 4),
    generation: 0,
    heap: new MinHeap(),
  };
}

/**
 * @param {Grid} grid
 * @param {Point} point
 * @returns {number}
 */
function vertexAt(grid, point) {
  return lowerBound(grid.xs, point.x) + lowerBound(grid.ys, point.y) * grid.nx;
}

/**
 * How many bits of a 32-bit integer are set.
 * @param {number} value
 * @returns {number}
 */
function bitCount(value) {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// `foreignMask` has a bit set for every group the link does not belong to.
/**
 * The cheapest route's vertices from the start stub to the end stub, or null
 * when nothing reaches the end.
 * @param {Grid} grid
 * @param {RoutePlan} plan
 * @param {number} foreignMask
 * @returns {number[] | null}
 */
function findPath(grid, plan, foreignMask) {
  const { xs, ys, nx, ny, blockH, blockV, usedH, usedV, passH, passV } = grid;
  const { groupH, groupV, titleH, titleV } = grid;
  const { gScore, stamp, closed, parent, heap } = grid;
  grid.generation += 1;
  const generation = grid.generation;

  const startV = vertexAt(grid, plan.startStub);
  const goalV = vertexAt(grid, plan.endStub);
  const goalX = plan.endStub.x;
  const goalY = plan.endStub.y;
  const arrival = (plan.targetSide + 2) % 4;

  /**
   * @param {number} x
   * @param {number} y
   */
  const heuristic = (x, y) => Math.abs(x - goalX) + Math.abs(y - goalY);

  heap.clear();
  const startState = startV * 4 + plan.sourceSide;
  gScore[startState] = 0;
  stamp[startState] = generation;
  parent[startState] = -1;
  heap.push(heuristic(plan.startStub.x, plan.startStub.y), startState);

  let best = -1;
  let bestCost = Infinity;

  while (heap.size > 0) {
    const state = heap.pop();
    if (heap.lastKey >= bestCost) break;
    if (closed[state] === generation) continue;
    closed[state] = generation;

    const dir = state & 3;
    const vertex = state >> 2;
    const g = gScore[state];

    if (vertex === goalV) {
      const total = g + (dir === arrival ? 0 : COST.bend);
      if (total < bestCost) {
        bestCost = total;
        best = state;
      }
      continue;
    }

    const ix = vertex % nx;
    const iy = (vertex - ix) / nx;
    for (let next = 0; next < 4; next += 1) {
      if (next === (dir + 2) % 4) continue;
      const jx = ix + DX[next];
      const jy = iy + DY[next];
      if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;

      const horizontal = next === E || next === W;
      const stepIndex = horizontal ? Math.min(ix, jx) + iy * nx : ix + Math.min(iy, jy) * nx;
      if (horizontal ? blockH[stepIndex] : blockV[stepIndex]) continue;

      const length = horizontal ? Math.abs(xs[jx] - xs[ix]) : Math.abs(ys[jy] - ys[iy]);
      const target = jx + jy * nx;
      let cost = length;
      if (next !== dir) cost += COST.bend;
      if (horizontal ? usedH[stepIndex] : usedV[stepIndex]) {
        cost += COST.overlapFlat + COST.overlapPerPx * length;
      }
      if (horizontal ? passV[target] : passH[target]) cost += COST.cross;
      const foreign = (horizontal ? groupH[stepIndex] : groupV[stepIndex]) & foreignMask;
      if (foreign) cost += length * COST.foreignGroupPerPx * bitCount(foreign);
      if (horizontal ? titleH[stepIndex] : titleV[stepIndex]) cost += length * COST.groupTitlePerPx;

      const nextState = target * 4 + next;
      const tentative = g + cost;
      if (stamp[nextState] !== generation || tentative < gScore[nextState]) {
        stamp[nextState] = generation;
        gScore[nextState] = tentative;
        parent[nextState] = state;
        heap.push(tentative + heuristic(xs[jx], ys[jy]), nextState);
      }
    }
  }

  if (best < 0) return null;

  /** @type {number[]} */ const vertices = [];
  for (let state = best; state >= 0; state = parent[state]) vertices.push(state >> 2);
  vertices.reverse();
  return vertices;
}

/**
 * Records a found route on the grid: the steps it takes and the vertices it
 * runs through.
 * @param {Grid} grid
 * @param {number[]} vertices
 */
function markRoute(grid, vertices) {
  const { nx } = grid;
  for (let i = 1; i < vertices.length; i += 1) {
    const a = vertices[i - 1];
    const b = vertices[i];
    const ax = a % nx;
    const bx = b % nx;
    const ay = (a - ax) / nx;
    const by = (b - bx) / nx;
    if (ay === by) {
      grid.usedH[Math.min(ax, bx) + ay * nx] += 1;
      grid.passH[a] = 1;
      grid.passH[b] = 1;
    } else {
      grid.usedV[ax + Math.min(ay, by) * nx] += 1;
      grid.passV[a] = 1;
      grid.passV[b] = 1;
    }
  }
}

// Other links should treat the short stub next to a node as already taken.
/**
 * @param {Grid} grid
 * @param {RoutePlan[]} plans
 * @param {RoutingOptions} cfg
 */
function reserveStubs(grid, plans, cfg) {
  /**
   * @param {Point} point
   * @param {Side} side
   */
  const reserve = (point, side) => {
    for (const distance of [cfg.clearance, cfg.stub]) {
      const v = vertexAt(grid, {
        x: point.x + DX[side] * distance,
        y: point.y + DY[side] * distance,
      });
      grid.passH[v] = 1;
      grid.passV[v] = 1;
    }
  };
  for (const plan of plans) {
    reserve(plan.start, plan.sourceSide);
    reserve(plan.end, plan.targetSide);
  }
}

/**
 * Drops repeated points and the middle of straight runs.
 * @param {Point[]} points
 * @returns {Point[]}
 */
export function simplifyPoints(points) {
  /** @type {Point[]} */ const out = [];
  for (const point of points) {
    const last = out.at(-1);
    if (last && last.x === point.x && last.y === point.y) continue;
    const before = out.at(-2);
    if (
      before &&
      ((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))
    ) {
      out[out.length - 1] = point;
    } else {
      out.push(point);
    }
  }
  return out;
}

// A link from a component to itself: out of one side, over the top, back in.
// Left to right it uses the right side; top to bottom the component's sticky
// notes sit on its right, so the loop takes the left side.
/**
 * @param {Rect} rect
 * @param {boolean} [horizontal]
 * @returns {Point[]}
 */
function selfLoop(rect, horizontal = true) {
  const reach = 22;
  const y0 = rect.y + rect.h / 2 - 8;
  const side = horizontal ? rect.x + rect.w : rect.x;
  const out = horizontal ? reach : -reach;
  const x1 = horizontal ? rect.x + rect.w - 28 : rect.x + 28;
  return [
    { x: side, y: y0 },
    { x: side + out, y: y0 },
    { x: side + out, y: rect.y - reach },
    { x: x1, y: rect.y - reach },
    { x: x1, y: rect.y },
  ];
}

// `ancestorsOf(nodeId)` returns the ids of the groups containing that node.
/**
 * Each link's route, by key.
 * @param {RouteInput} input
 * @param {Partial<RoutingOptions>} [options]
 * @returns {Map<string, Point[]>}
 */
export function routeEdges({ rects, groups, edges, ancestorsOf, horizontal }, options = {}) {
  const cfg = { ...ROUTING_DEFAULTS, ...options };
  /** @type {Map<string, Point[]>} */ const routes = new Map();
  /** @type {RoutePlan[]} */ const plans = [];

  edges.forEach((edge, index) => {
    if (edge.from === edge.to) {
      routes.set(edge.key, selfLoop(rects.get(edge.from), horizontal));
      return;
    }
    const a = rects.get(edge.from);
    const b = rects.get(edge.to);
    const [sourceSide, targetSide] = chooseSides(a, b, horizontal);
    plans.push({
      key: edge.key,
      from: edge.from,
      to: edge.to,
      index,
      sourceSide,
      targetSide,
      distance:
        Math.abs(a.x + a.w / 2 - (b.x + b.w / 2)) + Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)),
    });
  });
  if (plans.length === 0) return routes;

  assignPorts(plans, rects, cfg);
  const grid = buildGrid(rects, groups, plans, cfg);
  reserveStubs(grid, plans, cfg);

  const ordered = [...plans].sort((a, b) => a.distance - b.distance || a.index - b.index);
  for (const plan of ordered) {
    const owned = new Set([...ancestorsOf(plan.from), ...ancestorsOf(plan.to)]);
    let foreignMask = 0;
    groups.forEach((g, i) => {
      if (i < 31 && !owned.has(g.id)) foreignMask |= 1 << i;
    });

    const vertices = findPath(grid, plan, foreignMask);
    if (vertices) {
      markRoute(grid, vertices);
      const points = vertices.map((v) => {
        const ix = v % grid.nx;
        return { x: grid.xs[ix], y: grid.ys[(v - ix) / grid.nx] };
      });
      routes.set(plan.key, simplifyPoints([plan.start, ...points, plan.end]));
    } else {
      routes.set(plan.key, simplifyPoints([plan.start, plan.startStub, plan.endStub, plan.end]));
    }
  }
  return routes;
}
