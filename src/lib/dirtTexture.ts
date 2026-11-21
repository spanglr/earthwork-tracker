import * as THREE from "three";

/**
 * Soil textures made in code, so nothing is downloaded and there are no image
 * files to license.  Both tile seamlessly.
 *
 *   map   colour: mottled browns with fine grain and scattered stones
 *   bump  height: clods and stones, so the sun picks out some grain
 *
 * The look is illustrative.  It does not represent a soil type.
 */

/** One tile covers this many feet of ground. */
export const DIRT_TILE_FT = 40;

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth noise that repeats exactly every `size` pixels: a sum of octaves,
 *  each a random lattice with `period` cells across the tile. */
function tileableNoise(size: number, octaves: { period: number; amp: number }[], rand: () => number): Float32Array {
  const out = new Float32Array(size * size);
  let total = 0;
  for (const { period, amp } of octaves) {
    total += amp;
    const lattice = new Float32Array(period * period);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
    const cell = size / period;
    for (let y = 0; y < size; y++) {
      const fy = y / cell;
      const y0 = Math.floor(fy) % period;
      const y1 = (y0 + 1) % period;
      let ty = fy - Math.floor(fy);
      ty = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = x / cell;
        const x0 = Math.floor(fx) % period;
        const x1 = (x0 + 1) % period;
        let tx = fx - Math.floor(fx);
        tx = tx * tx * (3 - 2 * tx);
        const a = lattice[y0 * period + x0] * (1 - tx) + lattice[y0 * period + x1] * tx;
        const b = lattice[y1 * period + x0] * (1 - tx) + lattice[y1 * period + x1] * tx;
        out[y * size + x] += (a * (1 - ty) + b * ty) * amp;
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

const STOPS: [number, [number, number, number]][] = [
  [0.0, [92, 70, 49]], // damp, darker
  [0.45, [121, 95, 67]],
  [0.75, [140, 113, 82]],
  [1.0, [158, 132, 99]], // dry, paler
];
function soilColour(t: number): [number, number, number] {
  const u = Math.max(0, Math.min(1, t));
  for (let i = 1; i < STOPS.length; i++) {
    if (u <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1];
      const [t1, c1] = STOPS[i];
      const f = (u - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

let cache: { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } | null = null;

export function dirtTextures(size = 1024): { map: THREE.CanvasTexture; bump: THREE.CanvasTexture } {
  if (cache) return cache;
  const rand = mulberry32(20231708);
  // broad mottling down to clods
  const tone = tileableNoise(size, [
    { period: 3, amp: 0.3 }, { period: 6, amp: 0.4 }, { period: 13, amp: 0.55 }, { period: 27, amp: 0.7 }, { period: 55, amp: 0.6 }, { period: 110, amp: 0.45 },
  ], rand);
  const relief = tileableNoise(size, [
    { period: 8, amp: 0.5 }, { period: 20, amp: 0.7 }, { period: 48, amp: 1 }, { period: 100, amp: 0.8 }, { period: 200, amp: 0.5 },
  ], rand);

  const colour = new Uint8ClampedArray(size * size * 4);
  const height = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    // stretch contrast a little, then add per-pixel grain
    const t = (tone[i] - 0.5) * 1.5 + 0.5;
    const grain = 0.94 + rand() * 0.12;
    const [r, g, b] = soilColour(t);
    colour[4 * i] = r * grain;
    colour[4 * i + 1] = g * grain;
    colour[4 * i + 2] = b * grain;
    colour[4 * i + 3] = 255;
    height[i] = relief[i];
  }
  // scattered stones: paler in colour, raised in the bump map (wrapped at the edges)
  for (let n = 0; n < 900; n++) {
    const cx = rand() * size;
    const cy = rand() * size;
    const rad = 1 + rand() * rand() * 5;
    const shade = 0.75 + rand() * 0.55;
    const grey = rand() < 0.5;
    for (let dy = -Math.ceil(rad); dy <= Math.ceil(rad); dy++)
      for (let dx = -Math.ceil(rad); dx <= Math.ceil(rad); dx++) {
        const d = Math.hypot(dx, dy) / rad;
        if (d > 1) continue;
        const x = ((Math.floor(cx + dx) % size) + size) % size;
        const y = ((Math.floor(cy + dy) % size) + size) % size;
        const i = y * size + x;
        const k = 1 - d * d;
        const base = grey ? [150, 146, 138] : [168, 142, 108];
        for (let c = 0; c < 3; c++) colour[4 * i + c] = colour[4 * i + c] * (1 - k * 0.8) + base[c] * shade * k * 0.8;
        height[i] = Math.min(1, height[i] + k * 0.45);
      }
  }

  const make = (fill: (data: Uint8ClampedArray) => void, srgb: boolean) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(size, size);
    fill(img.data);
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
  cache = {
    map: make((d) => d.set(colour), true),
    bump: make((d) => {
      for (let i = 0; i < size * size; i++) {
        const v = height[i] * 255;
        d[4 * i] = d[4 * i + 1] = d[4 * i + 2] = v;
        d[4 * i + 3] = 255;
      }
    }, false),
  };
  return cache;
}

/** Slow brightness variation across the site so the repeating tile is not obvious
 *  from far away.  Returns a multiplier around 1. */
export function macroShade(xFt: number, zFt: number): number {
  const a = Math.sin(xFt * 0.021 + 1.3) * Math.cos(zFt * 0.017 - 0.4);
  const b = Math.sin((xFt + zFt) * 0.049 + 2.1) * Math.sin((xFt - zFt) * 0.037 + 0.7);
  const c = Math.sin(xFt * 0.11 + zFt * 0.083);
  return 0.98 + a * 0.07 + b * 0.045 + c * 0.02;
}
