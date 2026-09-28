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
} from '../src/params/plan';
import { loadCase, loadInputAsRgba } from './parity/compare';

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
    expect(plan.arenaKey).toBe('kodak_portra_400::print=kodak_portra_endura::m=0::y=0');
  });

  it('apron image mencakup halation, DIR, grain, dan unsharp; tanpa grain lebih kecil', () => {
    const withGrain = buildRenderPlan(BASELINE_RENDER_PARAMS, bundle, image('gray_ramp'), 'image');
    const noGrain = buildRenderPlan(DETERMINISTIC, bundle, image('gray_ramp'), 'image');
    expect(withGrain.overlap).toBe(256 * 3 + 64);
    expect(noGrain.overlap).toBe(256 * 3);
  });
});

describe('buildRenderPlan -> FrameParams', () => {
  it('baseline standard35 memberi filmFormatMm 35 (Python camera.film_format_mm default)', () => {
    expect(buildRenderPlan(BASELINE_RENDER_PARAMS, bundle, image('gray_ramp'), 'image').frame).toEqual({
      filmFormatMm: 35,
    });
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
      buildRenderPlan({ ...BASELINE_RENDER_PARAMS, film: 'kodak_gold_200' }, bundle, image('gray_ramp'), 'image'),
    ).toThrow(UnverifiedParameterError);
  });

  it('pasangan film/paper tanpa filter netral ter-bake gagal keras', () => {
    expect(() => resolveEnlargerFilters(bundle, 'kodak_gold_200', 'kodak_portra_endura', 0, 0)).toThrow(
      MissingNeutralFiltersError,
    );
  });
});
