// Picture to structure (decision 0023): the pixels of a picture, and the steps that make them what each recognition
// model was trained on. Pure functions over RGBA pixels, so the same code runs in the app, in its worker and in the
// checks. The webview's decoder reads the picture file in the app (recognise.ts); decodePng here is for the checks
// and the bench, and reads only 8-bit PNGs.

export type Pixels = { width: number; height: number; rgba: Uint8ClampedArray };
export type Box = { x: number; y: number; w: number; h: number };

// The most pixels a picture may have to be read: a 300 dpi A4 page is 8.7 million.
export const MAX_PIXELS = 40e6;

export function blank(width: number, height: number): Pixels {
  const rgba = new Uint8ClampedArray(width * height * 4);
  rgba.fill(255);
  return { width, height, rgba };
}

// Luminance as OpenCV's RGB to grey (ITU-R BT.601), rounded; transparent pixels count as white paper.
export function grey(p: Pixels): Uint8Array {
  const n = p.width * p.height, out = new Uint8Array(n), d = p.rgba;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3] / 255, y = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    out[i] = Math.round(y * a + 255 * (1 - a));
  }
  return out;
}

// A picture on white: transparency becomes white paper, as a screenshot of a page shows it.
export function onWhite(p: Pixels): Pixels {
  const d = p.rgba, out = new Uint8ClampedArray(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    out[i] = d[i] * a + 255 * (1 - a); out[i + 1] = d[i + 1] * a + 255 * (1 - a); out[i + 2] = d[i + 2] * a + 255 * (1 - a); out[i + 3] = 255;
  }
  return { width: p.width, height: p.height, rgba: out };
}

export function crop(p: Pixels, b: Box): Pixels {
  const x0 = Math.max(0, Math.floor(b.x)), y0 = Math.max(0, Math.floor(b.y));
  const x1 = Math.min(p.width, Math.ceil(b.x + b.w)), y1 = Math.min(p.height, Math.ceil(b.y + b.h));
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0), out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(p.rgba.subarray(((y0 + y) * p.width + x0) * 4, ((y0 + y) * p.width + x0 + w) * 4), y * w * 4);
  return { width: w, height: h, rgba: out };
}

// White paper round the picture, pad pixels on every side.
export function pad(p: Pixels, n: number): Pixels {
  const out = blank(p.width + 2 * n, p.height + 2 * n);
  for (let y = 0; y < p.height; y++) out.rgba.set(p.rgba.subarray(y * p.width * 4, (y + 1) * p.width * 4), ((y + n) * out.width + n) * 4);
  return out;
}

// The box of everything darker than paper: grey below `paper` (255 is MolScribe's own rule, exactly white). Undefined
// for a blank picture.
export function inkBox(p: Pixels, paper = 255): Box | undefined {
  const g = grey(p);
  let x0 = p.width, y0 = p.height, x1 = -1, y1 = -1;
  for (let y = 0; y < p.height; y++)
    for (let x = 0; x < p.width; x++)
      if (g[y * p.width + x] < paper) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? undefined : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// OpenCV's resize with INTER_LINEAR: pixel centres mapped half a pixel in, no smoothing when it shrinks. MolScribe
// was trained on pictures made this way (albumentations' Resize).
export function resizeLinear(p: Pixels, w: number, h: number): Pixels {
  const out = new Uint8ClampedArray(w * h * 4), sx = p.width / w, sy = p.height / h;
  const at = (s: number, n: number, scale: number) => {
    let f = (s + 0.5) * scale - 0.5, i = Math.floor(f);
    f -= i;
    if (i < 0) { i = 0; f = 0; }
    if (i >= n - 1) { i = n - 1; f = 0; }
    return [i, Math.min(i + 1, n - 1), f] as const;
  };
  const xs = Array.from({ length: w }, (_, x) => at(x, p.width, sx));
  for (let y = 0; y < h; y++) {
    const [y0, y1, fy] = at(y, p.height, sy);
    for (let x = 0; x < w; x++) {
      const [x0, x1, fx] = xs[x];
      for (let c = 0; c < 4; c++) {
        const v00 = p.rgba[(y0 * p.width + x0) * 4 + c], v01 = p.rgba[(y0 * p.width + x1) * 4 + c];
        const v10 = p.rgba[(y1 * p.width + x0) * 4 + c], v11 = p.rgba[(y1 * p.width + x1) * 4 + c];
        out[(y * w + x) * 4 + c] = Math.round((v00 * (1 - fx) + v01 * fx) * (1 - fy) + (v10 * (1 - fx) + v11 * fx) * fy);
      }
    }
  }
  return { width: w, height: h, rgba: out };
}

// Pillow's resize with BILINEAR: a triangle filter as wide as the scale when it shrinks, one direction at a time.
// OCSRGlyph was trained on pictures made this way.
export function resizeSmooth(p: Pixels, w: number, h: number): Pixels {
  const pass = (src: Uint8ClampedArray, sw: number, sh: number, dw: number, across: boolean): Uint8ClampedArray => {
    const n = across ? sw : sh, m = dw, scale = n / m, support = Math.max(scale, 1);
    const out = new Uint8ClampedArray((across ? dw * sh : sw * dw) * 4);
    for (let o = 0; o < m; o++) {
      const centre = (o + 0.5) * scale, lo = Math.max(0, Math.floor(centre - support)), hi = Math.min(n, Math.ceil(centre + support));
      const ws: number[] = [];
      let sum = 0;
      for (let i = lo; i < hi; i++) { const t = Math.max(0, 1 - Math.abs((i + 0.5 - centre) / support)); ws.push(t); sum += t; }
      for (let k = 0; k < (across ? sh : sw); k++)
        for (let c = 0; c < 4; c++) {
          let v = 0;
          for (let i = lo; i < hi; i++) v += ws[i - lo] * src[(across ? k * sw + i : i * sw + k) * 4 + c];
          out[(across ? k * dw + o : o * sw + k) * 4 + c] = Math.round(v / (sum || 1));
        }
    }
    return out;
  };
  const a = pass(p.rgba, p.width, p.height, w, true);
  return { width: w, height: h, rgba: pass(a, w, p.height, h, false) };
}

// The picture as the model's input: [1, 3, size, size], channel by channel.
export function tensor(p: Pixels, mean: number[], std: number[], toGrey: boolean): Float32Array {
  const n = p.width * p.height, out = new Float32Array(3 * n), g = toGrey ? grey(p) : undefined;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 3; c++) out[c * n + i] = ((g ? g[i] : p.rgba[i * 4 + c]) / 255 - mean[c]) / std[c];
  return out;
}

// MolScribe's input: cropped to its ink (pixels not exactly white), 5 white pixels round it, 384 square, grey, and
// normalised as ImageNet. The crop is returned too: the model's atom positions are fractions of it.
export function molscribeInput(p: Pixels, size = 384): { input: Float32Array; frame: Box } {
  const w = onWhite(p), box = inkBox(w) ?? { x: 0, y: 0, w: p.width, h: p.height };
  const framed = pad(crop(w, box), 5);
  return { input: tensor(resizeLinear(framed, size, size), [0.485, 0.456, 0.406], [0.229, 0.224, 0.225], true), frame: { x: box.x - 5, y: box.y - 5, w: box.w + 10, h: box.h + 10 } };
}

// OCSRGlyph's input: the picture as given, 384 square, colour, normalised to -1 to 1.
export function glyphInput(p: Pixels, size = 384): Float32Array {
  return tensor(resizeSmooth(onWhite(p), size, size), [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], false);
}

// A PNG (grey, grey and alpha, RGB, RGBA or a palette, 1 to 16 bits; interlaced is refused), for the checks and the bench.
export async function decodePng(bytes: Uint8Array): Promise<Pixels> {
  const u32 = (i: number) => ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
  if (u32(0) !== 0x89504e47) throw new Error("not a PNG");
  let i = 8, width = 0, height = 0, depth = 0, kind = 0, laced = 0, palette: Uint8Array | undefined, alpha: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  while (i + 8 <= bytes.length) {
    const len = u32(i), type = String.fromCharCode(...bytes.subarray(i + 4, i + 8)), data = bytes.subarray(i + 8, i + 8 + len);
    if (type === "IHDR") { width = u32(i + 8); height = u32(i + 12); depth = data[8]; kind = data[9]; laced = data[12]; }
    else if (type === "PLTE") palette = data;
    else if (type === "tRNS") alpha = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    i += 12 + len;
  }
  if (![1, 2, 4, 8, 16].includes(depth) || laced || width * height > MAX_PIXELS) throw new Error("only non-interlaced PNGs");
  const stream = new Blob(idat as BlobPart[]).stream().pipeThrough(new DecompressionStream("deflate"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const ch = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[kind], stride = Math.ceil((width * ch * depth) / 8);
  const bpp = Math.max(1, (ch * depth) >> 3), rgba = new Uint8ClampedArray(width * height * 4), top = (1 << depth) - 1;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
      line[x] += f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0;
    }
    // Sample k of the line, scaled to 0-255 (a palette index is left as it is).
    const sample = (k: number) => {
      if (depth === 8) return line[k];
      if (depth === 16) return line[k * 2];
      const v = (line[(k * depth) >> 3] >> (8 - depth - ((k * depth) & 7))) & top;
      return kind === 3 ? v : Math.round((v * 255) / top);
    };
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, s0 = x * ch;
      if (kind === 0 || kind === 4) { rgba[o] = rgba[o + 1] = rgba[o + 2] = sample(s0); rgba[o + 3] = kind === 4 ? sample(s0 + 1) : 255; }
      else if (kind === 3) { const k = sample(s0); rgba[o] = palette![k * 3]; rgba[o + 1] = palette![k * 3 + 1]; rgba[o + 2] = palette![k * 3 + 2]; rgba[o + 3] = alpha && k < alpha.length ? alpha[k] : 255; }
      else { rgba[o] = sample(s0); rgba[o + 1] = sample(s0 + 1); rgba[o + 2] = sample(s0 + 2); rgba[o + 3] = kind === 6 ? sample(s0 + 3) : 255; }
    }
    prev = line;
  }
  return { width, height, rgba };
}
