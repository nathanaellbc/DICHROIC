import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import { loadAssets } from '../src/profiles/load';
import type { AssetBundle } from '../src/profiles/load';
import { BASELINE_RENDER_PARAMS } from '../src/params/renderParams';
import { UnverifiedParameterError } from '../src/params/registry';
import {
  FILM_FORMAT_LONG_EDGE_MM,
  MissingNeutralFiltersError,
  buildRenderPlan,
  resolveEnlargerFilters,
  validateStocks,
} from '../src/params/plan';
import { loadCase, loadInputAsRgba } from './parity/compare';
import { dirRadiusPx, halationRadiusPx } from '../src/engine/spatialRadius';

let bundle: AssetBundle;
beforeAll(async () => {
  bundle = await loadAssets(join('public', 'data'));
});

const CASES = ['gray_ramp', 'log_gray_ramp', 'color_patches'];
const DETERMINISTIC = { ...BASELINE_RENDER_PARAMS, grainEnabled: false, glareEnabled: false };

/**
 * Snapshot `defaultCoreParams` Fase 1 (`test/parity/params.ts`, dihapus di
 * Fase 2A Task 3) untuk ketiga kasus, diambil dari fungsi itu sendiri
 * sebelum penghapusan. `filmExposureEv` = auto-exposure terukur; cocok
 * dengan rasio `rgb_pre/input` Python (2^-1.497558 = 0.354152 untuk
 * gray_ramp, lih. task-11-report.md). slot1: 13 = input compression |
 * glare | unsharp, 9 = tanpa glare, 1 = lut_mode.
 */
const MEASURED_EV: Record<string, number> = {
  gray_ramp: -1.497558056253559,
  log_gray_ramp: -1.4439689459978617,
  color_patches: -1.463731194980179,
};

function expectedCore(name: string, width: number, height: number, variant: 'stochastic' | 'deterministic' | 'cube') {
  return {
    width,
    height,
    filmExposureEv: variant === 'cube' ? 0 : MEASURED_EV[name]!,
    filmGamma: 1,
    exposureCount: 256,
    inputColorSpace: 19,
    rgbToRawMethod: 0,
    colorSpaceCount: 26,
    transferLutSize: 4096,
    colorDecodeMin: -0.125,
    colorDecodeMax: 1.5,
    hanatosWidth: 192,
    hanatosHeight: 192,
    slot0: variant === 'cube' ? 0 : 1,
    slot1: variant === 'stochastic' ? 13 : variant === 'deterministic' ? 9 : 1,
    slot2: 0,
    filmPushPullMode: 0,
    filmPushPullStops: 0,
    fullWidth: width,
    fullHeight: height,
    tileOriginX: 0,
    tileOriginY: 0,
    activeOriginX: 0,
    activeOriginY: 0,
    activeWidth: 0,
    activeHeight: 0,
  };
}

function image(name: string) {
  const meta = loadCase(name);
  return { width: meta.width, height: meta.height, rgba: loadInputAsRgba(name) };
}

describe('buildRenderPlan -> CoreParams setara defaultCoreParams Fase 1', () => {
  for (const name of CASES) {
    it(`${name}: image + baseline = measured stokastik`, () => {
      const img = image(name);
      const plan = buildRenderPlan(BASELINE_RENDER_PARAMS, bundle, img, 'image');
      expect(plan.core).toStrictEqual(expectedCore(name, img.width, img.height, 'stochastic'));
      expect(plan.chain).toEqual({ family: 'measured', grain: true });
    });

    it(`${name}: image + grain/glare mati = measured deterministik`, () => {
      const img = image(name);
      const plan = buildRenderPlan(DETERMINISTIC, bundle, img, 'image');
      expect(plan.core).toEqual(expectedCore(name, img.width, img.height, 'deterministic'));
      expect(plan.chain).toEqual({ family: 'measured', grain: false });
    });

    it(`${name}: cube = lut`, () => {
      const img = image(name);
      const plan = buildRenderPlan(BASELINE_RENDER_PARAMS, bundle, img, 'cube');
      expect(plan.core).toEqual(expectedCore(name, img.width, img.height, 'cube'));
      expect(plan.chain).toEqual({ family: 'lut', grain: false });
      expect(plan.overlap).toBe(0);
      expect(plan.disabledEffects).toContain('grain');
      expect(plan.disabledEffects).toContain('auto exposure');
    });
  }
});

describe('buildRenderPlan -> arena dan apron', () => {
  it('memakai filter netral ter-bake dan kunci arena yang memuat stock serta shift', () => {
    const plan = buildRenderPlan(BASELINE_RENDER_PARAMS, bundle, image('gray_ramp'), 'image');
    expect(plan.arenaInputs.stockId).toBe('kodak_portra_400');
    expect(plan.arenaInputs.printScan.printStockId).toBe('kodak_portra_endura');
    expect(plan.arenaInputs.printScan.enlargerFilters).toEqual({
      cFilterNeutral: bundle.manifest.printScan.neutralFilterC,
      mFilterNeutral: bundle.manifest.printScan.neutralFilterM,
      mFilterShift: 0,
      yFilterNeutral: bundle.manifest.printScan.neutralFilterY,
      yFilterShift: 0,
    });
    expect(plan.arenaKey).toBe('kodak_portra_400::print=kodak_portra_endura::c=0::m=0::y=0');
  });

  it('apron dari sigma sebenarnya: halation + DIR (spatialRadius.ts) + grain 64 + unsharp 256', () => {
    // gray_ramp 32 px, 35 mm -> 1093.75 um/px: halation 0 (bounce sigma 0.10 px),
    // DIR 2 (komponen ekor sigma 0.51 px, FIR int(3*0.51+0.5)).
    const withGrain = buildRenderPlan(BASELINE_RENDER_PARAMS, bundle, image('gray_ramp'), 'image');
    const noGrain = buildRenderPlan(DETERMINISTIC, bundle, image('gray_ramp'), 'image');
    expect(withGrain.overlap).toBe(0 + 2 + 64 + 256);
    expect(noGrain.overlap).toBe(0 + 2 + 256);
  });

  it('apron foto 6000 px (5.83 um/px) mengikuti radius IIR', () => {
    const big = { width: 6000, height: 4000, rgba: new Float32Array(4) };
    const px = 35000 / 6000;
    const expected = halationRadiusPx(px, [65, 65, 65]) + dirRadiusPx(px) + 256;
    expect(buildRenderPlan(DETERMINISTIC, bundle, big, 'image').overlap).toBe(expected);
    expect(expected).toBeGreaterThan(900);
  });
});

describe('buildRenderPlan -> FrameParams', () => {
  it('baseline standard35 memberi filmFormatMm 35 (Python camera.film_format_mm default)', () => {
    expect(buildRenderPlan(BASELINE_RENDER_PARAMS, bundle, image('gray_ramp'), 'image').frame).toEqual({
      filmFormatMm: 35,
      exposureCompensationEv: 0,
      printExposureCompensation: true,
      printExposure: 1,
      halationEnabled: true,
      halationAmount: 1,
      scannerUnsharpAmount: 0.7,
      glarePercent: 0.03,
      grainSeed: 1,
      grainAmount: 1,
      inputDecodeScale: 1,
    });
  });

  it('exposure print mengikuti digest_params: measured mengompensasi, cube (lut_mode) tidak', () => {
    const p = { ...BASELINE_RENDER_PARAMS, filmExposureEv: 1.5, printExposureEv: -1 };
    expect(buildRenderPlan(p, bundle, image('gray_ramp'), 'image').frame).toMatchObject({
      exposureCompensationEv: 1.5,
      printExposureCompensation: true,
      printExposure: 0.5,
    });
    const cube = buildRenderPlan(p, bundle, image('gray_ramp'), 'cube');
    expect(cube.frame).toMatchObject({ exposureCompensationEv: 0, printExposureCompensation: false, printExposure: 1 });
    expect(cube.core.filmExposureEv).toBe(0);
  });

  it('tabel sisi panjang format film mengikuti filmFormatLongEdgeMm OFX', () => {
    expect(FILM_FORMAT_LONG_EDGE_MM).toEqual({
      standard8: 4.8,
      super8: 5.79,
      standard16: 10.26,
      super16: 12.52,
      standard35: 35,
      super35: 24.89,
      standard65: 52.48,
      imax70: 70.41,
    });
  });
});

describe('buildRenderPlan -> penolakan', () => {
  it('memvalidasi parameter lebih dulu', () => {
    expect(() =>
      buildRenderPlan({ ...BASELINE_RENDER_PARAMS, rgbToRawMethod: 'hanatos2026' as 'hanatos2025' }, bundle, image('gray_ramp'), 'image'),
    ).toThrow(UnverifiedParameterError);
  });

  it('film reversal ditolak (batch parameter 2)', () => {
    let caught: unknown;
    try {
      buildRenderPlan({ ...BASELINE_RENDER_PARAMS, film: 'fujifilm_velvia_100' }, bundle, image('gray_ramp'), 'image');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnverifiedParameterError);
    expect((caught as UnverifiedParameterError).field).toBe('film');
    expect((caught as Error).message).toContain('reversal');
  });

  it('stock kertas sebagai film, dan film sebagai paper, ditolak', () => {
    expect(() => validateStocks(bundle, 'kodak_portra_endura', 'kodak_portra_endura')).toThrow(UnverifiedParameterError);
    expect(() => validateStocks(bundle, 'kodak_portra_400', 'kodak_portra_400')).toThrow(UnverifiedParameterError);
    expect(() => validateStocks(bundle, 'kodak_gold_200', 'kodak_2383')).not.toThrow();
  });

  it('filter netral dari database Python per pasangan', () => {
    const baseline = resolveEnlargerFilters(bundle, 'kodak_portra_400', 'kodak_portra_endura', 0, 0, 0);
    expect(baseline.mFilterNeutral).toBe(bundle.manifest.printScan.neutralFilterM);
    expect(baseline.yFilterNeutral).toBe(bundle.manifest.printScan.neutralFilterY);
    expect(() => resolveEnlargerFilters(bundle, 'kodak_portra_400', 'bukan_paper', 0, 0, 0)).toThrow(
      MissingNeutralFiltersError,
    );
  });
});
