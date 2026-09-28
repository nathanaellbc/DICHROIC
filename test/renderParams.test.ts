import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BASELINE_RENDER_PARAMS } from '../src/params/renderParams';
import type { RenderParams } from '../src/params/renderParams';
import {
  FIELD_STATUS,
  UnverifiedParameterError,
  applyParamsPatch,
  validateRenderParams,
} from '../src/params/registry';

describe('validateRenderParams', () => {
  it('menerima baseline', () => {
    expect(() => validateRenderParams(BASELINE_RENDER_PARAMS)).not.toThrow();
  });

  it('menolak field locked yang berbeda dari baseline, menyebut field, nilai, dan baseline', () => {
    let caught: unknown;
    try {
      validateRenderParams({ ...BASELINE_RENDER_PARAMS, filmExposureEv: 1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnverifiedParameterError);
    const err = caught as UnverifiedParameterError;
    expect(err.field).toBe('filmExposureEv');
    expect(err.value).toBe(1);
    expect(err.baseline).toBe(0);
    expect(err.message).toContain('filmExposureEv');
    expect(err.message).toContain('1');
    expect(err.message).toContain('0');
  });

  it('menangkap -0 dan NaN sebagai beda dari baseline 0', () => {
    expect(() => validateRenderParams({ ...BASELINE_RENDER_PARAMS, printExposureEv: -0 })).toThrow(
      UnverifiedParameterError,
    );
    expect(() => validateRenderParams({ ...BASELINE_RENDER_PARAMS, printExposureEv: NaN })).toThrow(
      UnverifiedParameterError,
    );
  });

  it('menerima grain dan glare mati bersamaan (keluarga <case> Fase 1)', () => {
    expect(() =>
      validateRenderParams({ ...BASELINE_RENDER_PARAMS, grainEnabled: false, glareEnabled: false }),
    ).not.toThrow();
  });

  it('menolak grain dan glare campuran, kombinasi yang belum digerbangi', () => {
    let caught: unknown;
    try {
      validateRenderParams({ ...BASELINE_RENDER_PARAMS, grainEnabled: false, glareEnabled: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnverifiedParameterError);
    expect((caught as UnverifiedParameterError).field).toBe('glareEnabled');
  });
});

describe('applyParamsPatch', () => {
  it('atomik: patch yang ditolak tidak mengubah parameter asal', () => {
    const current: RenderParams = { ...BASELINE_RENDER_PARAMS };
    const snapshot = { ...current };
    expect(() => applyParamsPatch(current, { film: 'kodak_gold_200' })).toThrow(UnverifiedParameterError);
    expect(current).toEqual(snapshot);
  });

  it('mengembalikan objek baru untuk patch yang sah', () => {
    const current: RenderParams = { ...BASELINE_RENDER_PARAMS };
    const next = applyParamsPatch(current, { grainEnabled: false, glareEnabled: false });
    expect(next).not.toBe(current);
    expect(next.grainEnabled).toBe(false);
    expect(current.grainEnabled).toBe(true);
  });
});

describe('FIELD_STATUS', () => {
  it('mencakup tepat kunci-kunci baseline', () => {
    expect(Object.keys(FIELD_STATUS).sort()).toEqual(Object.keys(BASELINE_RENDER_PARAMS).sort());
  });

  it('setiap field verified punya penanda @verifies di test/', () => {
    const corpus = testSources(join('test')).join('\n');
    const verified = (Object.keys(FIELD_STATUS) as Array<keyof RenderParams>).filter(
      (f) => FIELD_STATUS[f] === 'verified',
    );
    expect(verified.length).toBeGreaterThan(0);
    for (const field of verified) {
      const marker = new RegExp(`@verifies\\b[^\\n]*\\b${field}\\b`);
      expect(marker.test(corpus), `tidak ada "@verifies ${field}" di test/`).toBe(true);
    }
  });
});

function testSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'fixtures') out.push(...testSources(path));
    } else if (name.endsWith('.ts') && name !== 'renderParams.test.ts') {
      out.push(readFileSync(path, 'utf8'));
    }
  }
  return out;
}
