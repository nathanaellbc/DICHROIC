// @extends cameraExposureEv cameraWhiteBalanceK cameraTint cameraContrast cameraHighlights cameraShadows cameraWhites cameraBlacks cameraSaturation cameraHsvSaturation -- ekstensi "Camera Raw", digerbangi terhadap referensi JS
import { describe, it, expect } from 'vitest';
import {
  hsvSaturationPixel,
  cameraDevelopPixel,
  cameraFrameValues,
  developLuma,
  illuminantXyz,
  invert3,
  measureScenePivot,
  NEUTRAL_CAMERA,
  whiteBalanceRgb,
  whiteBalanceXyz,
} from '../src/host/cameraDevelop';
import { buildChain } from '../src/engine/chain';
import { RenderGraph } from '../src/engine/graph';
import { Tap } from '../src/engine/taps';
import { buildRenderPlan, validateCamera } from '../src/params/plan';
import { BASELINE_RENDER_PARAMS } from '../src/params/renderParams';
import type { RenderParams } from '../src/params/renderParams';
import { sharedResources } from './parity/run';
import { Session } from '../src/session/session';
import { findTool, sliderPatch, sliderRange, valueText } from '../src/ui/model/tools';
import type { SliderTool } from '../src/ui/model/tools';

/**
 * "Camera Raw" bukan bagian spektrafilm, jadi tidak ada oracle Python. Dua
 * lapis gerbang:
 *  1. matematika host (WB von Kries CAT02, tone, pivot) terhadap sifat yang
 *     harus dipenuhinya;
 *  2. tahap GPU terhadap referensi JS f64 (`cameraDevelopPixel`): render
 *     dengan Camera Raw == render netral dari input yang di-develop di CPU,
 *     di tap `log_e_film` (setelah halation), <= 1e-5 log10 -- ambang yang
 *     sama dengan gerbang parity Python. Terukur 1e-7..2.1e-6 di lavapipe;
 *     yang terbesar dari campuran saturasi 1.8 (`y + s(c - y)`), yang
 *     membatalkan digit f32 pada warna jenuh.
 * Netral = tahap dilewati persis (tidak ada uniform yang diisi), jadi seluruh
 * gerbang parity Python tetap berlaku.
 */

const STOCK_ID = 'kodak_portra_400';
const PRINT = {
  printStockId: 'kodak_portra_endura',
  enlargerFilters: { cFilterNeutral: 0, mFilterNeutral: 51.56801468495496, mFilterShift: 0, yFilterNeutral: 52.53400422349596, yFilterShift: 0 },
};

const PROPHOTO_TO_XYZ = [0.7976749, 0.1351917, 0.0313534, 0.2880402, 0.7118741, 0.0000857, 0, 0, 0.82521];

describe('Camera Raw: matematika host', () => {
  it('HSV S gain preserves Hue and Value, clamps saturation, and retains HDR headroom', () => {
    const hsv = (rgb: readonly number[]) => {
      const v = Math.max(...rgb), min = Math.min(...rgb), d = v - min;
      const [r, g, b] = rgb as [number, number, number];
      const h = d === 0 ? 0 : ((v === r ? (g - b) / d : v === g ? 2 + (b - r) / d : 4 + (r - g) / d) + 6) % 6;
      return [h, v === 0 ? 0 : d / v, v] as const;
    };
    for (const rgb of [[0.8, 0.6, 0.4], [0.4, 0.8, 0.6], [0.6, 0.4, 0.8], [4, 1, 2], [0, 0, 0], [2, 2, 2], [1e-9, 3e-9, 2e-9]] as const) {
      for (const gain of [0, 0.5, 1, 1.5, 2]) {
        const out = hsvSaturationPixel(rgb, gain);
        const before = hsv(rgb), after = hsv(out);
        expect(after[2]).toBeCloseTo(before[2], 12);
        expect(after[1]).toBeCloseTo(Math.min(before[1] * gain, 1), 12);
        if (after[1] > 0) expect(after[0]).toBeCloseTo(before[0], 12);
        if (gain === 1) expect(out).toEqual(rgb);
      }
    }
    expect(hsvSaturationPixel([4, 1, 2], 2)[2]).toBeCloseTo(4 / 3, 12);
    expect(() => validateCamera({ ...BASELINE_RENDER_PARAMS, cameraHsvSaturation: 2.01 })).toThrow(RangeError);
    expect(() => validateCamera({ ...BASELINE_RENDER_PARAMS, cameraHsvSaturation: NaN })).toThrow(RangeError);
  });

  it('HSV UI maps neutral 100 and range 0..200 to channel gain', () => {
    const tool = findTool('cameraHsvSaturation') as SliderTool;
    expect(sliderRange(tool, BASELINE_RENDER_PARAMS)).toEqual({ min: 0, max: 200, step: 1 });
    expect(sliderPatch(tool, 150)).toEqual({ cameraHsvSaturation: 1.5 });
    expect(valueText(tool, BASELINE_RENDER_PARAMS)).toBe('100');
  });

  it('exposure in stops doubles linear RGB without clipping HDR values', () => {
    const rgb = [0.125, 0.25, 2] as const;
    for (const exposureEv of [-5, -1, 1, 5]) {
      const frame = cameraFrameValues({ ...NEUTRAL_CAMERA, exposureEv }, PROPHOTO_TO_XYZ, 0.2);
      cameraDevelopPixel(rgb, frame).forEach((v, i) => expect(v).toBeCloseTo(rgb[i]! * 2 ** exposureEv, 6));
    }
    expect(() => validateCamera({ ...BASELINE_RENDER_PARAMS, cameraExposureEv: 5.01 })).toThrow(RangeError);
    expect(() => validateCamera({ ...BASELINE_RENDER_PARAMS, cameraExposureEv: Number.NaN })).toThrow(RangeError);
  });
  it('white balance 5500 K / tint 0 = identitas; iluminan sumber dipetakan ke 5500 K', () => {
    const id = whiteBalanceXyz(5500, 0);
    id.forEach((v, i) => expect(v).toBeCloseTo(i % 4 === 0 ? 1 : 0, 12));
    for (const [t, tint] of [[3200, 0], [8000, 0.5], [2000, -1], [12000, 1]] as const) {
      const w = whiteBalanceXyz(t, tint);
      const src = illuminantXyz(t, tint);
      const dst = illuminantXyz(5500, 0);
      const mapped = [0, 1, 2].map((r) => w[r * 3]! * src[0] + w[r * 3 + 1]! * src[1] + w[r * 3 + 2]! * src[2]);
      mapped.forEach((v, k) => expect(v).toBeCloseTo(dst[k]!, 10));
    }
    // Adegan tungsten (3200 K) dikoreksi menjadi lebih biru: B/R naik.
    const rgb = whiteBalanceRgb(PROPHOTO_TO_XYZ, 3200, 0);
    const grey = [0, 1, 2].map((r) => rgb[r * 3]! + rgb[r * 3 + 1]! + rgb[r * 3 + 2]!);
    expect(grey[2]! / grey[0]!).toBeGreaterThan(1.3);
  });

  it('tint + (cahaya hijau) dikoreksi ke magenta: G turun relatif R dan B', () => {
    const rgb = whiteBalanceRgb(PROPHOTO_TO_XYZ, 5500, 1);
    const grey = [0, 1, 2].map((r) => rgb[r * 3]! + rgb[r * 3 + 1]! + rgb[r * 3 + 2]!);
    expect(grey[1]!).toBeLessThan(grey[0]!);
    expect(grey[1]!).toBeLessThan(grey[2]!);
  });

  it('tone: identitas saat netral, pivot tetap di bawah contrast, masker di sisi yang benar', () => {
    const neutral = { pivot: 0.2, contrast: 1, highlights: 0, shadows: 0, whites: 0, blacks: 0 };
    for (const y of [1e-4, 0.05, 0.2, 1, 7]) expect(developLuma(y, neutral)).toBeCloseTo(y, 12);
    expect(developLuma(0.2, { ...neutral, contrast: 2 ** 0.75 })).toBeCloseTo(0.2, 12);
    // Shadows mengangkat bayangan jauh lebih banyak daripada sorotan.
    const lift = (y: number) => Math.log2(developLuma(y, { ...neutral, shadows: 1 }) / y);
    expect(lift(0.2 / 16)).toBeGreaterThan(0.8);
    expect(lift(0.2 * 16)).toBeLessThan(0.01);
    // Highlights sebaliknya.
    const cut = (y: number) => Math.log2(developLuma(y, { ...neutral, highlights: -1 }) / y);
    expect(cut(0.2 * 16)).toBeLessThan(-0.8);
    expect(cut(0.2 / 16)).toBeGreaterThan(-0.01);
  });

  it('pivot = rata-rata log luminans; gambar gelap total jatuh ke 0.18', () => {
    const rgba = new Float32Array(2 * 1 * 4);
    rgba.set([0.1, 0.1, 0.1, 1, 0.4, 0.4, 0.4, 1]);
    expect(measureScenePivot(rgba, 2, 1, [0.3, 0.6, 0.1])).toBeCloseTo(0.2, 7); // input f32
    expect(measureScenePivot(new Float32Array(16), 2, 2, [0.3, 0.6, 0.1])).toBe(0.18);
  });

  it('netral -> uniform nol (flag mati); invert3 benar', () => {
    const neutral = cameraFrameValues(
      { ...NEUTRAL_CAMERA },
      PROPHOTO_TO_XYZ,
      0.2,
    );
    expect([...neutral].every((v) => v === 0)).toBe(true);
    const inv = invert3(PROPHOTO_TO_XYZ);
    const back = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => [0, 1, 2].reduce((a, k) => a + inv[i * 3 + k]! * PROPHOTO_TO_XYZ[k * 3 + j]!, 0)));
    back.forEach((v, i) => expect(v).toBeCloseTo(i % 4 === 0 ? 1 : 0, 12));
  });

  it('rentang divalidasi', () => {
    expect(() => validateCamera({ ...BASELINE_RENDER_PARAMS, cameraWhiteBalanceK: 1999 })).toThrow(RangeError);
    expect(() => validateCamera({ ...BASELINE_RENDER_PARAMS, cameraSaturation: 2.01 })).toThrow(RangeError);
    expect(() => validateCamera({ ...BASELINE_RENDER_PARAMS, cameraContrast: Number.NaN })).toThrow(RangeError);
    expect(() => validateCamera({ ...BASELINE_RENDER_PARAMS, cameraBlacks: -2, cameraWhites: 2 })).not.toThrow();
  });
});

function colourImage(width: number, height: number): { width: number; height: number; rgba: Float32Array } {
  const rgba = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = x / (width - 1);
      const level = 0.002 * 2 ** (12 * t);
      const hue = (y / height) * Math.PI * 2;
      const o = (y * width + x) * 4;
      rgba[o] = level * (1 + 0.6 * Math.cos(hue));
      rgba[o + 1] = level * (1 + 0.6 * Math.cos(hue - 2.1));
      rgba[o + 2] = level * (1 + 0.6 * Math.cos(hue + 2.1));
      rgba[o + 3] = 1;
    }
  }
  return { width, height, rgba };
}

describe('Camera Raw: tahap GPU == referensi JS', () => {
  const SETTINGS: Array<Partial<RenderParams>> = [
    { cameraHsvSaturation: 0 },
    { cameraHsvSaturation: 0.5 },
    { cameraHsvSaturation: 2 },
    { cameraHsvSaturation: 1.7, cameraExposureEv: 2, cameraWhiteBalanceK: 3200, cameraSaturation: 0.7 },
    { cameraExposureEv: 1 },
    { cameraExposureEv: -5 },
    { cameraExposureEv: 5, cameraHighlights: -1, cameraWhiteBalanceK: 6500 },
    { cameraWhiteBalanceK: 3200, cameraTint: 0.4 },
    { cameraContrast: 0.5, cameraHighlights: -1.2, cameraShadows: 1.1 },
    { cameraWhites: 1.5, cameraBlacks: -1.5, cameraSaturation: 0.3 },
    { cameraWhiteBalanceK: 9000, cameraTint: -0.8, cameraContrast: -0.6, cameraSaturation: 1.8, cameraShadows: -0.7 },
  ];

  it.each(SETTINGS.map((s, i) => [i, s] as const))('kasus %i', async (_i, patch) => {
    const { engine, bundle, arenas } = await sharedResources(STOCK_ID, PRINT);
    const base: RenderParams = { ...BASELINE_RENDER_PARAMS, autoExposure: false, grainEnabled: false, glareEnabled: false };
    const image = colourImage(64, 48);
    const plan = buildRenderPlan({ ...base, ...patch }, bundle, image, 'image');
    const frame = plan.frame.camera!;
    expect(frame[22]).toBe(1);

    const developed = new Float32Array(image.rgba.length);
    for (let p = 0; p < image.width * image.height; p += 1) {
      const out = cameraDevelopPixel([image.rgba[p * 4]!, image.rgba[p * 4 + 1]!, image.rgba[p * 4 + 2]!], frame);
      developed.set([...out, 1], p * 4);
    }
    const reference = buildRenderPlan(base, bundle, { ...image, rgba: developed }, 'image');
    expect(reference.frame.camera).toBeUndefined();

    const graph = new RenderGraph(engine);
    for (const stage of buildChain(engine.device, arenas, plan.chain)) graph.addStage(stage);
    const opts = { maxBufferBytes: engine.maxStorageBufferBindingSize, overlap: plan.overlap };
    const got = await graph.run(image.rgba, plan.core, Tap.LOG_E_FILM, { ...opts, frame: plan.frame });
    const want = await graph.run(developed, reference.core, Tap.LOG_E_FILM, { ...opts, frame: reference.frame });
    graph.dispose();

    let maxAbs = 0;
    for (let p = 0; p < image.width * image.height; p += 1) {
      for (let c = 0; c < 3; c += 1) maxAbs = Math.max(maxAbs, Math.abs(got[p * 4 + c]! - want[p * 4 + c]!));
    }
    expect(maxAbs, `log_e_film max ${maxAbs.toExponential(3)}`).toBeLessThanOrEqual(1e-5);
  }, 120_000);
});

describe('HSV Saturation: cached Session rendering', () => {
  it('updates an already rendered neutral preview, reaches full output, and resets exactly', async () => {
    const { engine, bundle } = await sharedResources(STOCK_ID, PRINT);
    const session = await Session.create({ assetsBaseUrl: 'public/data', engine, bundle,
      arenaProvider: { get: async (_key, inputs) => (await sharedResources(inputs.stockId, inputs.printScan)).arenas } });
    try {
      session.open({ ...colourImage(64, 48), suggestedColorSpace: 'sRGB', encoding: 'linear', source: { format: 'fixture', bitDepth: 32 } });
      session.setParams({ autoExposure: false, grainEnabled: false, glareEnabled: false, inputColorSpace: 'sRGB', inputCctfDecoding: false });
      const before = await session.render('preview');
      session.setParams({ cameraHsvSaturation: 1.8 });
      const after = await session.render('preview');
      expect(Math.max(...after.rgb.map((v, i) => Math.abs(v - before.rgb[i]!)))).toBeGreaterThan(0.01);
      const full = await session.render('full');
      expect(full.rgb).toEqual(after.rgb);
      session.setParams({ cameraHsvSaturation: 1 });
      const restored = await session.render('preview');
      expect(restored.rgb).toEqual(before.rgb);
      expect(restored.paramsVersion).toBeGreaterThan(after.paramsVersion);
    } finally { session.dispose(); }
  }, 120000);
});
