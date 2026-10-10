import { describe, expect, it } from 'vitest';
import { GuideImage, boxMean, depthLayers, guidedFilterColor, guidedFilterGray, refineDepth, slidingExtreme } from '../../src/depth/matte';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('matte: filter dasar', () => {
  it('boxMean dan slidingExtreme = brute force (jendela dijepit di tepi)', () => {
    const w = 13, h = 9, r = 3, rand = rng(7);
    const src = Float32Array.from({ length: w * h }, rand);
    const mean = boxMean(src, w, h, r, new Float32Array(w * h), new Float32Array(w * h));
    const mx = slidingExtreme(src, w, h, r, true);
    const mn = slidingExtreme(src, w, h, r, false);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      let s = 0, c = 0, hi = -Infinity, lo = Infinity;
      for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j += 1) for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i += 1) {
        const v = src[j * w + i]!; s += v; c += 1; hi = Math.max(hi, v); lo = Math.min(lo, v);
      }
      expect(mean[y * w + x]).toBeCloseTo(s / c, 5);
      expect(mx[y * w + x]).toBe(Math.fround(hi));
      expect(mn[y * w + x]).toBe(Math.fround(lo));
    }
  });

  it('guided filter membersihkan derau kedalaman tanpa melunakkan tepi yang sejajar foto', () => {
    const w = 64, h = 32, rand = rng(11);
    const guide = new Uint8ClampedArray(w * h * 4);
    const depth = new Float32Array(w * h);
    const ideal = (x: number) => (x < 32 ? 0.2 : 0.9);
    for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      // Foto: tepi tajam di x = 32. Kedalaman: tepi sama + derau jaringan ±0,1.
      guide.set(x < 32 ? [40, 30, 90, 255] : [220, 150, 60, 255], i * 4);
      depth[i] = ideal(x) + (rand() - 0.5) * 0.2;
    }
    const error = (q: Float32Array) => {
      let e = 0;
      for (let i = 0; i < w * h; i += 1) e += Math.abs(q[i]! - ideal(i % w));
      return e / (w * h);
    };
    for (const filter of [guidedFilterColor, guidedFilterGray]) {
      const q = filter(new GuideImage(guide, w, h), depth, 4, 1e-3);
      expect(error(q) / error(depth), filter.name).toBeLessThan(0.35);
      // Tepi tetap tegas: satu piksel di tiap sisi masih dekat nilainya sendiri.
      expect(Math.abs(q[16 * w + 31]! - 0.2), filter.name).toBeLessThan(0.08);
      expect(Math.abs(q[16 * w + 32]! - 0.9), filter.name).toBeLessThan(0.08);
    }
  });
});

describe('matte: dua lapis kedalaman (rambut)', () => {
  // Kiri: subjek dekat (d = 1). Kanan: latar jauh (d = 0) bertekstur gelap.
  // Helai terang 1 px menjulur ke latar -- jaringan tidak melihatnya, jadi
  // peta kedalaman hanya punya tepi lembut di x ~ 40.
  const w = 96, h = 48;
  const guide = new Uint8ClampedArray(w * h * 4);
  const depth = new Float32Array(w * h);
  const strand = (x: number, y: number) => x >= 40 && x < 60 && (x + y) % 6 === 0;
  const rand = rng(3);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const i = y * w + x;
    const bg = 50 + rand() * 25;
    if (x < 40 || strand(x, y)) guide.set([235, 205, 140, 255], i * 4);
    else guide.set([bg * 0.8, bg * 0.5, bg, 255], i * 4);
    depth[i] = Math.min(Math.max((44 - x) / 8, 0), 1);
  }
  // Radius sebanding gambar uji 96 px (bawaan mengikuti guide 1024..2048 px).
  const opts = { lowMemory: false, radii: { depth: 2, zone: 24, matte: 1 } };
  const g = new GuideImage(guide, w, h);
  const layers = depthLayers(refineDepth(depth, g, opts), g, opts);

  it('helai tipis masuk lapis depan, latar di selanya tidak', () => {
    let strandAlpha = 0, strandN = 0, gapAlpha = 0, gapN = 0;
    for (let y = 8; y < 40; y += 1) for (let x = 42; x < 52; x += 1) {
      const a = layers.alpha[y * w + x]!;
      if (strand(x, y)) { strandAlpha += a; strandN += 1; }
      else if (!strand(x - 1, y) && !strand(x + 1, y)) { gapAlpha += a; gapN += 1; }
    }
    expect(strandAlpha / strandN).toBeGreaterThan(0.6);
    expect(gapAlpha / gapN).toBeLessThan(0.35);
  });

  it('di zona tepi: lapis depan = subjek, lapis belakang = latar', () => {
    const i = 24 * w + 46;
    expect(layers.foreground[i]).toBeGreaterThan(0.7);
    expect(layers.background[i]).toBeLessThan(0.15);
  });

  it('jauh dari tepi: netral (depan = belakang, alpha = 1)', () => {
    for (const x of [2, 92]) {
      const i = 24 * w + x;
      expect(layers.alpha[i]).toBe(1);
      expect(layers.foreground[i]).toBeCloseTo(layers.background[i]!, 6);
    }
  });
});
