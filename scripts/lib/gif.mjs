// An animated GIF encoder with no dependencies, for the README recordings.
//  - One palette for the whole animation: a median cut over the colours of
//    every frame (UI screenshots have few colours, so 255 are plenty).
//  - Each frame after the first only stores the rectangle that changed, with
//    unchanged pixels inside it transparent: a recording of small edits stays
//    small.
//  - LZW as the GIF89a specification has it, 12-bit codes at most.
// frames: [{ width, height, data: RGBA Uint8Array, ms }]; returns a Buffer.

const TRANSPARENT = 255;
const PALETTE_SIZE = 255;
// The most frequent exact colours (backgrounds, borders, text) keep their
// exact value; the rest (antialiasing) share what is left of the palette.
const EXACT = 128;

const rgbKey = (r, g, b) => (r << 16) | (g << 8) | b;

function histogram(frames) {
  const counts = new Map();
  let previous = null;
  for (const frame of frames) {
    const { data } = frame;
    for (let i = 0; i < data.length; i += 4) {
      if (previous && data[i] === previous[i] && data[i + 1] === previous[i + 1] && data[i + 2] === previous[i + 2]) continue;
      const k = rgbKey(data[i], data[i + 1], data[i + 2]);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    previous = data;
  }
  return counts;
}

// Median cut over exact colours, weighted by how often they appear.
function medianCut(colors, size) {
  if (colors.length === 0 || size <= 0) return [];
  const span = (box) => {
    let best = null;
    for (const ch of ['r', 'g', 'b']) {
      let lo = 255;
      let hi = 0;
      for (const c of box) {
        lo = Math.min(lo, c[ch]);
        hi = Math.max(hi, c[ch]);
      }
      if (!best || hi - lo > best.span) best = { ch, span: hi - lo };
    }
    return best;
  };
  const boxes = [colors];
  while (boxes.length < size) {
    let pick = -1;
    let score = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      const population = box.reduce((sum, c) => sum + c.n, 0);
      const value = span(box).span * Math.sqrt(population);
      if (value > score) {
        score = value;
        pick = i;
      }
    });
    if (pick < 0) break;
    const box = boxes[pick];
    const { ch } = span(box);
    box.sort((a, b) => a[ch] - b[ch]);
    const half = box.reduce((sum, c) => sum + c.n, 0) / 2;
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < box.length - 1; i += 1) {
      acc += box[i].n;
      if (acc >= half) {
        cut = i + 1;
        break;
      }
    }
    boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map((box) => {
    const total = box.reduce((sum, c) => sum + c.n, 0) || 1;
    const avg = (ch) => Math.round(box.reduce((sum, c) => sum + c[ch] * c.n, 0) / total);
    return [avg('r'), avg('g'), avg('b')];
  });
}

function buildPalette(counts) {
  const colors = [...counts].map(([k, n]) => ({ r: (k >> 16) & 255, g: (k >> 8) & 255, b: k & 255, n }));
  colors.sort((a, b) => b.n - a.n);
  if (colors.length <= PALETTE_SIZE) return colors.map((c) => [c.r, c.g, c.b]);
  const exact = colors.slice(0, EXACT);
  return [...exact.map((c) => [c.r, c.g, c.b]), ...medianCut(colors.slice(EXACT), PALETTE_SIZE - EXACT)];
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.current = 0;
    this.bits = 0;
  }

  write(code, size) {
    this.current |= code << this.bits;
    this.bits += size;
    while (this.bits >= 8) {
      this.bytes.push(this.current & 255);
      this.current >>= 8;
      this.bits -= 8;
    }
  }

  finish() {
    if (this.bits > 0) this.bytes.push(this.current & 255);
    return Uint8Array.from(this.bytes);
  }
}

function lzw(indices, minCodeSize = 8) {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  const dict = new Map();
  const out = new BitWriter();
  out.write(clear, codeSize);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const known = dict.get(prefix * 256 + k);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    out.write(prefix, codeSize);
    if (next < 4096) {
      if (next >= 1 << codeSize && codeSize < 12) codeSize += 1;
      dict.set(prefix * 256 + k, next);
      next += 1;
    } else {
      out.write(clear, codeSize);
      dict.clear();
      codeSize = minCodeSize + 1;
      next = end + 1;
    }
    prefix = k;
  }
  out.write(prefix, codeSize);
  if (next >= 1 << codeSize && codeSize < 12) codeSize += 1;
  out.write(end, codeSize);
  return out.finish();
}

function subBlocks(bytes) {
  const blocks = Math.ceil(bytes.length / 255);
  const out = new Uint8Array(bytes.length + blocks + 1);
  let o = 0;
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    out[o++] = chunk.length;
    out.set(chunk, o);
    o += chunk.length;
  }
  out[o] = 0;
  return out;
}

const u16 = (n) => [n & 255, (n >> 8) & 255];

export function encodeGif(frames) {
  if (!frames.length) throw new Error('no frames');
  const { width, height } = frames[0];
  for (const f of frames) if (f.width !== width || f.height !== height) throw new Error('every frame must have the same size');

  const palette = buildPalette(histogram(frames));
  const used = palette.length;
  while (palette.length < 256) palette.push([0, 0, 0]);
  const nearest = new Map();
  const indexOf = (r, g, b) => {
    const k = rgbKey(r, g, b);
    let index = nearest.get(k);
    if (index === undefined) {
      let best = Infinity;
      for (let i = 0; i < used; i += 1) {
        const [pr, pg, pb] = palette[i];
        const d = (pr - r) ** 2 * 3 + (pg - g) ** 2 * 4 + (pb - b) ** 2 * 2;
        if (d < best) {
          best = d;
          index = i;
        }
      }
      nearest.set(k, index);
    }
    return index;
  };

  const parts = [];
  const put = (...values) => parts.push(Uint8Array.from(values));
  put(...Buffer.from('GIF89a'), ...u16(width), ...u16(height), 0xf7, 0, 0);
  put(...palette.flat());
  put(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0, 0, 0);

  let previous = null;
  for (const frame of frames) {
    const { data } = frame;
    let x0 = 0;
    let y0 = 0;
    let x1 = width - 1;
    let y1 = height - 1;
    if (previous) {
      x0 = width;
      y0 = height;
      x1 = -1;
      y1 = -1;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const i = (y * width + x) * 4;
          if (data[i] !== previous[i] || data[i + 1] !== previous[i + 1] || data[i + 2] !== previous[i + 2]) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) {
        // Nothing changed: a 1x1 transparent frame carries the delay.
        x0 = 0;
        y0 = 0;
        x1 = 0;
        y1 = 0;
      }
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const indices = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = ((y0 + y) * width + (x0 + x)) * 4;
        const same = previous && data[i] === previous[i] && data[i + 1] === previous[i + 1] && data[i + 2] === previous[i + 2];
        indices[y * w + x] = same ? TRANSPARENT : indexOf(data[i], data[i + 1], data[i + 2]);
      }
    }
    const delay = Math.max(2, Math.round((frame.ms ?? 100) / 10));
    put(0x21, 0xf9, 0x04, (1 << 2) | (previous ? 1 : 0), ...u16(delay), TRANSPARENT, 0);
    put(0x2c, ...u16(x0), ...u16(y0), ...u16(w), ...u16(h), 0);
    put(8);
    parts.push(subBlocks(lzw(indices, 8)));
    previous = data;
  }
  put(0x3b);
  return Buffer.concat(parts);
}
