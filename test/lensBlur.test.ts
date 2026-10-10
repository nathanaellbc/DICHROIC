// @extends lensBlurEnabled lensFocusX lensFocusY lensFocusDistanceM lensFocalLengthMm lensFNumber lensBlades lensBladeCurvature lensCatEye lensNearSharpM lensForeground -- ekstensi lens blur (sifat thin-lens + gather)
import { describe, it, expect } from 'vitest';
import {
  cocAtInfinityMm,
  depthOfField,
  lensReadout,
  nearSharpDisparity,
  resolveLensFrame,
  sampleDisparity,
  signedCocPx,
} from '../src/host/lens';
import type { DepthMap, LensSettings } from '../src/host/lens';
import { buildChain } from '../src/engine/chain';
import { RenderGraph } from '../src/engine/graph';
import { Tap } from '../src/engine/taps';
import { createMaterializeActiveRegionStage } from '../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../src/engine/stages/filmExposure';
import { createLensBlurStage } from '../src/engine/stages/lensBlur';
import { buildRenderPlan, validateLens } from '../src/params/plan';
import { BASELINE_RENDER_PARAMS } from '../src/params/renderParams';
import type { RenderParams } from '../src/params/renderParams';
import { sharedResources } from './parity/run';

/**
 * Lens blur bukan bagian spektrafilm (tidak ada oracle Python). Gerbangnya:
 *  1. thin-lens host: CoC, kedalaman ruang, zona tajam dekat -- terhadap
 *     rumus tertutup;
 *  2. tahap GPU terhadap sifat yang harus dipenuhi defocus fisik: piksel dalam
 *     fokus keluar bit-identik; titik cahaya menjadi cakram berdiameter CoC
 *     dengan energi terjaga; latar tidak menimpa subjek tajam di depannya.
 * Tanpa `lensBlurEnabled` atau tanpa peta kedalaman tahapnya tidak dibangun
 * sama sekali, jadi rantai yang digerbangi Python tidak berubah.
 */

const STOCK_ID = 'kodak_portra_400';
const PRINT = {
  printStockId: 'kodak_portra_endura',
  enlargerFilters: { cFilterNeutral: 0, mFilterNeutral: 51.56801468495496, mFilterShift: 0, yFilterNeutral: 52.53400422349596, yFilterShift: 0 },
};

const SETTINGS: LensSettings = {
  focusX: 0.5,
  focusY: 0.5,
  focusDistanceM: 2.5,
  focalLengthMm: 0,
  fNumber: 2,
  blades: 0,
  bladeCurvature: 0.5,
  catEye: 0,
  nearSharpM: 0,
  foreground: 1,
};

describe('lens blur: thin-lens host', () => {
  it('CoC di tak hingga dan kedalaman ruang = rumus tertutup', () => {
    expect(cocAtInfinityMm(50, 2, 2500)).toBeCloseTo((50 * 50) / (2 * 2450), 12);
    const dof = depthOfField(50, 8, 3000, 0.03);
    const H = (50 * 50) / (8 * 0.03) + 50;
    expect(dof.hyperfocalMm).toBeCloseTo(H, 9);
    expect(dof.nearMm).toBeCloseTo((3000 * (H - 50)) / (H + 3000 - 100), 9);
    expect(dof.farMm).toBeCloseTo((3000 * (H - 50)) / (H - 3000), 9);
    expect(depthOfField(50, 8, 20000, 0.03).farMm).toBe(Infinity);
  });

  it('CoC bertanda: + di belakang, - di depan, nol di fokus; zona tajam dekat dan porsi foreground', () => {
    expect(signedCocPx(0.5, 0.5, 40, 100)).toBe(0);
    expect(signedCocPx(0, 0.5, 40, 100)).toBe(40);
    expect(signedCocPx(1, 0.5, 40, 100)).toBe(-40);
    expect(signedCocPx(0, 0.5, 400, 100)).toBe(100); // dijepit ke jangkauan gather
    // Tajam sampai batas dekat 1.0 (subjek 2x lebih dekat dari fokus), lalu tumbuh dari sana.
    expect(nearSharpDisparity(0.5, 2000, 1000)).toBeCloseTo(1, 12);
    expect(signedCocPx(0.9, 0.5, 40, 100, 1)).toBe(-0);
    expect(signedCocPx(1.25, 0.5, 40, 100, 1)).toBeCloseTo(-20, 12);
    expect(signedCocPx(1.25, 0.5, 40, 100, 1, 0.5)).toBeCloseTo(-10, 12);
    expect(signedCocPx(1.25, 0.5, 40, 100, 1, 0)).toBe(-0);
  });

  it('skala CoC mengikuti pitch piksel render; titik fokus = median jendela', () => {
    const depth: DepthMap = { width: 9, height: 9, data: new Float32Array(81).fill(0.25) };
    depth.data[40] = 0.9; // satu piksel tepi di bawah titik fokus: median mengabaikannya
    const a = resolveLensFrame(SETTINGS, depth, 'standard35', 35, 1000);
    const b = resolveLensFrame(SETTINGS, depth, 'standard35', 35, 4000);
    expect(a.focusDisparity).toBe(0.25);
    expect(b.cocScalePx / a.cocScalePx).toBeCloseTo(4, 12);
    expect(a.cocScalePx).toBeCloseTo(cocAtInfinityMm(50, 2, 2500) * (1000 / 35), 12);
    expect(a.maxCocPx).toBeCloseTo(100, 12);
    expect(sampleDisparity(depth, 0.5, 0.5, 0)).toBeCloseTo(0.9, 6);
  });

  it('readout: foreground dipotong -> batas dekat 0; lensa normal per format', () => {
    expect(lensReadout({ ...SETTINGS, foreground: 0 }, 'standard35', 35, 1.5).nearLimitM).toBe(0);
    expect(lensReadout(SETTINGS, 'super16', 12.52, 1.66).focalLengthMm).toBe(16);
    const r = lensReadout({ ...SETTINGS, fNumber: 8, focusDistanceM: 3 }, 'standard35', 35, 1.5);
    expect(r.nearLimitM).toBeLessThan(3);
    expect(r.farLimitM).toBeGreaterThan(3);
  });

  it('rentang divalidasi', () => {
    const ok = { ...BASELINE_RENDER_PARAMS };
    expect(() => validateLens(ok)).not.toThrow();
    expect(() => validateLens({ ...ok, lensBlades: 4 })).toThrow(RangeError);
    expect(() => validateLens({ ...ok, lensFNumber: 1 })).toThrow(RangeError);
    expect(() => validateLens({ ...ok, lensFocalLengthMm: 5 })).toThrow(RangeError);
    expect(() => validateLens({ ...ok, lensNearSharpM: 3 })).toThrow(RangeError); // > jarak fokus 2.5
    expect(() => validateLens({ ...ok, lensNearSharpM: 1, lensFocusX: 1, lensCatEye: 1 })).not.toThrow();
  });
});

const SIZE = 256;

function pointLight(background = 0.002, peak = 400): { width: number; height: number; rgba: Float32Array } {
  const rgba = new Float32Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i += 1) rgba.set([background, background, background, 1], i * 4);
  for (const [x, y] of [[127, 127], [128, 127], [127, 128], [128, 128]] as const) rgba.set([peak, peak, peak, 1], (y * SIZE + x) * 4);
  return { width: SIZE, height: SIZE, rgba };
}

const BASE: RenderParams = {
  ...BASELINE_RENDER_PARAMS,
  autoExposure: false,
  grainEnabled: false,
  glareEnabled: false,
  lensBlurEnabled: true,
  lensFocalLengthMm: 200,
  lensFNumber: 2,
};

/** Rantai sampai tahap lens blur saja: keluarannya raw linear film. */
async function lensOnly(image: { width: number; height: number; rgba: Float32Array }, params: RenderParams, depth: DepthMap | undefined) {
  const { engine, bundle, arenas } = await sharedResources(STOCK_ID, PRINT);
  const plan = buildRenderPlan(params, bundle, image, 'image', depth ? { depth } : {});
  const graph = new RenderGraph(engine);
  graph.addStage(createMaterializeActiveRegionStage(engine.device));
  graph.addStage(createFilmExposureStage(engine.device, arenas));
  if (plan.chain.lensBlur) graph.addStage(createLensBlurStage(engine.device));
  const out = await graph.run(image.rgba, plan.core, Tap.LOG_E_FILM, {
    maxBufferBytes: engine.maxStorageBufferBindingSize,
    overlap: 0,
    frame: plan.frame,
  });
  graph.dispose();
  return { out, plan };
}

describe('lens blur: tahap GPU', () => {
  it('dalam fokus di mana-mana -> keluaran BIT-IDENTIK dengan tanpa lens blur', async () => {
    const image = pointLight();
    const depth: DepthMap = { width: 32, height: 32, data: new Float32Array(32 * 32).fill(0.6) };
    const { out: blurred, plan } = await lensOnly(image, BASE, depth);
    expect(plan.chain.lensBlur).toBe(true);
    const { out: sharp, plan: plain } = await lensOnly(image, BASE, undefined);
    expect(plain.chain.lensBlur).toBeUndefined();
    let diff = 0;
    for (let i = 0; i < blurred.length; i += 1) if (blurred[i] !== sharp[i]) diff += 1;
    expect(diff).toBe(0);
  }, 120_000);

  it('titik cahaya di tak hingga -> cakram berdiameter CoC, energi terjaga', async () => {
    const image = pointLight();
    // Peta seragam 0 = semuanya di tak hingga; titik fokus jatuh ke MIN_FOCUS_DISPARITY.
    const depth: DepthMap = { width: 16, height: 16, data: new Float32Array(256) };
    const { out: blurred, plan } = await lensOnly(image, BASE, depth);
    const { out: sharp } = await lensOnly(image, BASE, undefined);
    const diameter = Math.min(plan.frame.lens!.cocScalePx, plan.frame.lens!.maxCocPx);
    expect(diameter).toBeCloseTo(25.6, 6); // dijepit 10% sisi panjang
    const bg = sharp[0]!;
    let energyIn = 0;
    let energyOut = 0;
    let inside = 0;
    let insideCount = 0;
    let outsideMax = 0;
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const i = (y * SIZE + x) * 4 + 1;
        energyIn += sharp[i]! - bg;
        energyOut += blurred[i]! - bg;
        const r = Math.hypot(x + 0.5 - 128, y + 0.5 - 128);
        if (r < diameter / 2 - 4) {
          inside += blurred[i]! - bg;
          insideCount += 1;
        } else if (r > diameter / 2 + 8) {
          // Pita tepi 8 px render = 4 sel grid: gather di setengah resolusi
          // plus tenda upsample dan prefilter mip melunakkan tepi cakram
          // sekitar dua sel grid (terukur 2,7% dari rata-rata cakram di +5 px).
          outsideMax = Math.max(outsideMax, blurred[i]! - bg);
        }
      }
    }
    const discMean = inside / insideCount;
    expect(energyOut / energyIn, 'energi').toBeGreaterThan(0.9);
    expect(energyOut / energyIn, 'energi').toBeLessThan(1.1);
    // Cakram seragam: rata-rata di dalamnya ~ energi / luas cakram.
    expect(discMean / (energyIn / (Math.PI * (diameter / 2) ** 2))).toBeGreaterThan(0.7);
    expect(discMean / (energyIn / (Math.PI * (diameter / 2) ** 2))).toBeLessThan(1.3);
    expect(outsideMax / discMean, 'di luar cakram').toBeLessThan(0.02);
  }, 120_000);

  it('subjek tajam di depan latar blur tidak ditimpa; foreground blur menutupi latar tajam', async () => {
    // Kiri: subjek dekat (d = 1, fokus), kanan: latar jauh (d = 0). Latar terang.
    const width = SIZE;
    const rgba = new Float32Array(width * SIZE * 4);
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const v = x < 128 ? 0.02 : 2;
        rgba.set([v, v, v, 1], (y * width + x) * 4);
      }
    }
    const image = { width, height: SIZE, rgba };
    const depthData = new Float32Array(64 * 64);
    for (let y = 0; y < 64; y += 1) for (let x = 0; x < 64; x += 1) depthData[y * 64 + x] = x < 32 ? 1 : 0;
    const depth: DepthMap = { width: 64, height: 64, data: depthData };
    const focusNear = { ...BASE, lensFocusX: 0.2, lensFocusY: 0.5 };
    const { out } = await lensOnly(image, focusNear, depth);
    const { out: sharp } = await lensOnly(image, focusNear, undefined);
    // Subjek tajam: 3 px dari tepi pun tidak kena cahaya latar yang blur.
    for (const x of [60, 100, 124]) {
      const i = (128 * width + x) * 4 + 1;
      expect(out[i], `x=${x}`).toBe(sharp[i]);
    }

    // Balik: fokus di latar jauh, subjek dekat (gelap) blur menutupi latar.
    const focusFar = { ...BASE, lensFocusX: 0.8, lensFocusY: 0.5 };
    const { out: fg } = await lensOnly(image, focusFar, depth);
    const edge = (128 * width + 131) * 4 + 1;
    expect(fg[edge]!, 'foreground gelap menyebar ke latar').toBeLessThan(sharp[edge]! * 0.9);
  }, 120_000);

  it('dua lapis (rambut): helai tipis tetap tajam, latar di selanya blur dan tidak ternoda helai', async () => {
    // Kiri: subjek gelap dekat (fokus). Kanan: latar jauh bergaris (1 | 3,
    // periode 4 px). Helai gelap 1 px menjulur ke latar; peta kedalaman TIDAK
    // memuatnya (jaringan tidak melihatnya), lapisan dari matte memuatnya.
    const width = SIZE;
    const strands = new Set([132, 142, 152, 162]);
    const rgba = new Float32Array(width * SIZE * 4);
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const v = x < 120 || strands.has(x) ? 0.02 : (x >> 1) % 2 ? 3 : 1;
        rgba.set([v, v, v, 1], (y * width + x) * 4);
      }
    }
    const image = { width, height: SIZE, rgba };
    const n = width * SIZE;
    const data = new Float32Array(n);
    const foreground = new Float32Array(n);
    const background = new Float32Array(n);
    const alpha = new Float32Array(n).fill(1);
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = y * width + x;
        data[i] = x < 120 ? 1 : 0;
        const zone = x >= 112 && x < 180;
        foreground[i] = zone ? 1 : data[i]!;
        background[i] = zone ? 0 : data[i]!;
        if (zone) alpha[i] = x < 120 || strands.has(x) ? 1 : 0;
      }
    }
    const focus = { ...BASE, lensFocusX: 0.2, lensFocusY: 0.5 };
    const plain: DepthMap = { width, height: SIZE, data };
    const layered: DepthMap = { width, height: SIZE, data, layers: { foreground, background, alpha } };
    const { out: one } = await lensOnly(image, focus, plain);
    const { out: two } = await lensOnly(image, focus, layered);
    const { out: sharp } = await lensOnly(image, focus, undefined);
    const g = (out: Float32Array, x: number) => out[(128 * width + x) * 4 + 1]!;
    // Latar tanpa helai jauh dari subjek = rujukan blur latar.
    const farBg = g(one, 220);
    expect(Math.abs(g(sharp, 220) - farBg), 'latar memang blur').toBeGreaterThan(0.2);
    for (const x of strands) {
      // Satu lapis: helai ikut lapis latar dan luntur jadi blur.
      expect(g(one, x) / g(sharp, x), `satu lapis x=${x}`).toBeGreaterThan(5);
      // Dua lapis: helai keluar persis tajam.
      expect(g(two, x), `dua lapis x=${x}`).toBe(g(sharp, x));
      // Sela di antara helai: latar blur (bukan garis tajam), tidak digelapkan helai.
      const gap = g(two, x + 5);
      expect(Math.abs(gap - farBg) / farBg, `sela x=${x + 5}`).toBeLessThan(0.2);
    }
  }, 120_000);

  it('rantai penuh: lens blur hanya dibangun bila aktif dan ada peta kedalaman', async () => {
    const { bundle, arenas, engine } = await sharedResources(STOCK_ID, PRINT);
    const image = pointLight();
    const depth: DepthMap = { width: 8, height: 8, data: new Float32Array(64) };
    const names = (p: RenderParams, d?: DepthMap) =>
      buildChain(engine.device, arenas, buildRenderPlan(p, bundle, image, 'image', d ? { depth: d } : {}).chain).map((s) => s.name);
    expect(names(BASE, depth).slice(0, 4)).toEqual(['materializeActiveRegion', 'filmExposure', 'lensBlur', 'diffusion:camera']);
    expect(names(BASE)).not.toContain('lensBlur');
    expect(names({ ...BASE, lensBlurEnabled: false }, depth)).not.toContain('lensBlur');
    expect(buildRenderPlan(BASE, bundle, image, 'cube', { depth }).chain.lensBlur).toBeUndefined();
  }, 120_000);
});
