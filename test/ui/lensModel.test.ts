import { describe, it, expect } from 'vitest';
import { F_STOPS, LENS_LIMITS, NORMAL_FOCAL_MM } from '../../src/host/lens';
import { BASELINE_RENDER_PARAMS } from '../../src/params/renderParams';
import type { RenderParams } from '../../src/params/renderParams';
import {
  GROUPS,
  findTool,
  isModified,
  normalizePatch,
  positionPatch,
  sliderPosition,
  sliderRange,
  stepperPatch,
  stepperText,
  valueText,
} from '../../src/ui/model/tools';
import type { SliderTool, StepperTool } from '../../src/ui/model/tools';

/**
 * Grup Lens (ekstensi lens blur, `host/lens.ts`): slider berskala log dengan
 * nilai 0 yang bermakna, stepper dengan daftar nilai, dan patch yang menjaga
 * kombinasi yang divalidasi `plan.ts` (batas tajam dekat <= jarak fokus).
 */

const P = (patch: Partial<RenderParams> = {}): RenderParams => ({ ...BASELINE_RENDER_PARAMS, lensBlurEnabled: true, ...patch });
const slider = (id: string) => findTool(id) as SliderTool;
const stepper = (id: string) => findTool(id) as StepperTool;

describe('grup Lens', () => {
  it('ada setelah Camera, alat pertama adalah sakelar lens blur', () => {
    const ids = GROUPS.map((g) => g.id);
    expect(ids.indexOf('lens')).toBe(ids.indexOf('camera') + 1);
    const lens = GROUPS.find((g) => g.id === 'lens')!;
    expect(lens.tools[0]!.kind).toBe('lens');
  });

  it('alat lensa tidak "diubah" hanya karena lens blur menyala; sakelarnya milik alat Lens', () => {
    const lens = GROUPS.find((g) => g.id === 'lens')!;
    const on = P();
    for (const tool of lens.tools) {
      if (tool.kind === 'lens') continue;
      expect(isModified(tool, on, BASELINE_RENDER_PARAMS), tool.id).toBe(false);
      // Tanpa enabledBy: tidak ada sakelar lens blur duplikat di tiap alat.
      expect((tool as { enabledBy?: string }).enabledBy, tool.id).toBeUndefined();
      expect((tool as { requires?: string }).requires, tool.id).toBe('lensBlurEnabled');
    }
    expect(isModified(slider('lensFocusDistanceM'), P({ lensFocusDistanceM: 5 }), BASELINE_RENDER_PARAMS)).toBe(true);
  });

  it('sakelar lens blur: tidak termodifikasi di baseline, termodifikasi saat dinyalakan', () => {
    const tool = findTool('lensBlur');
    expect(isModified(tool, BASELINE_RENDER_PARAMS, BASELINE_RENDER_PARAMS)).toBe(false);
    expect(isModified(tool, P(), BASELINE_RENDER_PARAMS)).toBe(true);
  });
});

describe('jarak fokus (log10)', () => {
  const tool = slider('lensFocusDistanceM');

  it('rentang posisi = log10 batas engine', () => {
    const r = sliderRange(tool, P());
    expect(r.min).toBeCloseTo(Math.log10(LENS_LIMITS.focusDistanceM.min), 12);
    expect(r.max).toBeCloseTo(Math.log10(LENS_LIMITS.focusDistanceM.max), 12);
    expect(sliderPosition(tool, P({ lensFocusDistanceM: 2.5 }))).toBeCloseTo(Math.log10(2.5), 12);
  });

  it('posisi -> meter dengan pembulatan yang dibaca manusia', () => {
    expect(positionPatch(tool, Math.log10(7.3), P())).toEqual({ lensFocusDistanceM: 7.3 });
    expect(positionPatch(tool, Math.log10(0.456), P())).toEqual({ lensFocusDistanceM: 0.46 });
    expect(positionPatch(tool, Math.log10(23.7), P())).toEqual({ lensFocusDistanceM: 24 });
    expect(valueText(tool, P({ lensFocusDistanceM: 0.46 }))).toBe('0.46 m');
    expect(valueText(tool, P({ lensFocusDistanceM: 24 }))).toBe('24 m');
  });

  it('posisi di ujung selalu tepat di batas (tidak meleset karena log)', () => {
    expect(positionPatch(tool, sliderRange(tool, P()).max, P())).toEqual({ lensFocusDistanceM: 100 });
    expect(positionPatch(tool, sliderRange(tool, P()).min, P())).toEqual({ lensFocusDistanceM: 0.3 });
  });
});

describe('batas tajam dekat (0 = bidang fokus, maks = jarak fokus)', () => {
  const tool = slider('lensNearSharpM');

  it('0 berada di ujung maks, yang mengikuti jarak fokus', () => {
    const params = P({ lensFocusDistanceM: 2.5, lensNearSharpM: 0 });
    expect(sliderRange(tool, params).max).toBeCloseTo(Math.log10(2.5), 12);
    expect(sliderPosition(tool, params)).toBeCloseTo(Math.log10(2.5), 12);
    expect(valueText(tool, params)).toBe('At focus');
  });

  it('menyeret ke ujung maks menulis 0; di tengah menulis meter', () => {
    const params = P({ lensFocusDistanceM: 2.5 });
    expect(positionPatch(tool, Math.log10(2.5), params)).toEqual({ lensNearSharpM: 0 });
    expect(positionPatch(tool, Math.log10(1.2), params)).toEqual({ lensNearSharpM: 1.2 });
    expect(sliderRange(tool, params).min).toBeCloseTo(Math.log10(LENS_LIMITS.nearSharpM.min), 12);
  });

  it('menurunkan jarak fokus di bawah batas tajam dekat mereset batas itu dalam patch yang sama', () => {
    const params = P({ lensFocusDistanceM: 5, lensNearSharpM: 3 });
    expect(normalizePatch(params, { lensFocusDistanceM: 2 })).toEqual({ lensFocusDistanceM: 2, lensNearSharpM: 0 });
    expect(normalizePatch(params, { lensFocusDistanceM: 4 })).toEqual({ lensFocusDistanceM: 4 });
    expect(normalizePatch(params, { grainAmount: 1.5 })).toEqual({ grainAmount: 1.5 });
  });
});

describe('panjang fokus (log2, 0 = lensa normal format)', () => {
  const tool = slider('lensFocalLengthMm');

  it('0 digambar di posisi lensa normal format', () => {
    expect(sliderPosition(tool, P())).toBeCloseTo(Math.log2(NORMAL_FOCAL_MM.standard35), 12);
    expect(sliderPosition(tool, P({ filmFormat: 'super16' }))).toBeCloseTo(Math.log2(NORMAL_FOCAL_MM.super16), 12);
    expect(valueText(tool, P())).toBe('50 mm · Normal');
  });

  it('menyeret menulis mm bulat; rentang = batas engine', () => {
    expect(positionPatch(tool, Math.log2(85.4), P())).toEqual({ lensFocalLengthMm: 85 });
    const r = sliderRange(tool, P());
    expect(2 ** r.min).toBeCloseTo(LENS_LIMITS.focalLengthMm.min, 9);
    expect(2 ** r.max).toBeCloseTo(LENS_LIMITS.focalLengthMm.max, 9);
    expect(valueText(tool, P({ lensFocalLengthMm: 85 }))).toBe('85 mm');
  });
});

describe('stepper berdaftar nilai', () => {
  it('bukaan melangkah sepertiga stop F_STOPS', () => {
    const tool = stepper('lensFNumber');
    expect(stepperPatch(tool, P({ lensFNumber: 2 }), 1)).toEqual({ lensFNumber: 2.2 });
    expect(stepperPatch(tool, P({ lensFNumber: 2 }), -1)).toEqual({ lensFNumber: 1.8 });
    expect(stepperPatch(tool, P({ lensFNumber: F_STOPS[0] }), -1)).toEqual({});
    expect(stepperPatch(tool, P({ lensFNumber: 22 }), 1)).toEqual({});
    expect(stepperText(tool, P({ lensFNumber: 2.8 }))).toBe('f/2.8');
  });

  it('bilah iris: bulat lalu 5..9', () => {
    const tool = stepper('lensBlades');
    expect(stepperPatch(tool, P({ lensBlades: 0 }), 1)).toEqual({ lensBlades: 5 });
    expect(stepperPatch(tool, P({ lensBlades: 5 }), -1)).toEqual({ lensBlades: 0 });
    expect(stepperText(tool, P({ lensBlades: 0 }))).toBe('Round');
    expect(stepperText(tool, P({ lensBlades: 7 }))).toBe('7 blades');
  });
});

describe('slider linear tetap seperti sebelumnya', () => {
  it('posisi = nilai (dan invert tetap dibalik)', () => {
    const exposure = slider('printExposureEv');
    expect(sliderPosition(exposure, P({ printExposureEv: 0.5 }))).toBe(-0.5);
    expect(positionPatch(exposure, 0.7, P())).toEqual({ printExposureEv: -0.7 });
    expect(sliderRange(exposure, P())).toEqual({ min: -2, max: 2, step: 0.1 });
  });
});
