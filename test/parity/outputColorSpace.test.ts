// @verifies outputColorSpace -- keluarga param/out_* (Fase 2C Task 9)
import { beforeAll, describe, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Tap } from '../../src/engine/taps';
import { prepareParamCases, runParamParity } from './planRun';

/**
 * Colour space keluaran lewat jalur produksi: matriks `scanToOutputRgb`
 * per label, gamut compression CAM16-UCS dengan whitepoint, matriks, dan tabel
 * `C_max` ruang itu, lalu `cctf_encoding` colour (sRGB, ROMM, gamma, linear).
 * Ke-10 label di `manifest.outputColorSpaces` diuji di keluarga `lut`, tiga di
 * antaranya juga measured (unsharp di ruang keluaran). Hanya `rgb_out` yang
 * tersentuh; ambang 1e-5.
 */

const CASES = readdirSync(join('test', 'fixtures', 'param'))
  .filter((n) => n.startsWith('out_'))
  .sort();

beforeAll(async () => {
  await prepareParamCases(CASES);
}, 180_000);

describe('parity colour space keluaran (param/)', () => {
  for (const name of CASES) {
    it(`rgb_out / ${name}`, async () => {
      await runParamParity(name, Tap.RGB_OUT, 1e-5);
    });
  }
});
