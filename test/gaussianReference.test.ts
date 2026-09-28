import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gaussianFilterCpu, exponentialFilterCpu } from '../src/engine/gaussianReference';
import { readF32 } from './readF32';

/**
 * Referensi CPU f64 dari `fast_gaussian_filter` (dipakai self-test presisi
 * GPU saat `Session.create`). Digerbangi terhadap oracle Python yang sama
 * dengan `GaussianBlur` (`test/fixtures/gaussian`). Input oracle dibulatkan
 * ke f32 saat disimpan (Python memakai f64), jadi ambang 2e-7 menampung
 * pembulatan input itu saja.
 */

const DIR = join('test', 'fixtures', 'gaussian');

describe('gaussianFilterCpu vs fast_gaussian_filter', () => {
  for (const name of ['zero', 'small', 'threshold', 'large', 'mixed', 'narrow', 'exponential']) {
    it(name, () => {
      const c = JSON.parse(readFileSync(join(DIR, name, 'case.json'), 'utf8')) as {
        kind: string;
        sigma: [number, number, number];
        truncate: number;
        width: number;
        height: number;
      };
      const input = readF32(join(DIR, name, 'input.f32'));
      const expected = readF32(join(DIR, name, 'output.f32'));
      const actual =
        c.kind === 'gaussian'
          ? gaussianFilterCpu(input, c.width, c.height, c.sigma, c.truncate)
          : exponentialFilterCpu(input, c.width, c.height, c.sigma, c.truncate);
      let maxAbs = 0;
      for (let i = 0; i < expected.length; i += 1) maxAbs = Math.max(maxAbs, Math.abs(actual[i]! - expected[i]!));
      expect(maxAbs, `${name}: ${maxAbs.toExponential(3)}`).toBeLessThanOrEqual(2e-7);
    });
  }
});
