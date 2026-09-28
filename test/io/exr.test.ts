import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeImage, DecodeError } from '../../src/io';
import { describeBitIdenticalDecoder } from './codecGates';
import { loadIoExpected, loadIoInput, loadIoMeta } from './ioFixtures';

const SUGGESTED: Record<string, string> = {
  exr_ap0: 'ACES2065-1',
  exr_ap1: 'ACEScg',
  exr_rec2020: 'Linear Rec.2020',
};

describe('EXR vs OpenImageIO', () => {
  describeBitIdenticalDecoder('exr', {
    suggestedColorSpace: (name) => SUGGESTED[name] ?? 'Linear Rec.709',
    encoding: () => 'linear',
    notBitIdentical: ['exr_half_dwaa'],
  });
});

/** Pola bit half bertanda untuk nilai f32 yang tepat terwakili half (hasil decode half). */
function halfOrdinal(value: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  const bits = view.getUint32(0);
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const magnitude = exponent >= 1 ? (exponent << 10) | ((bits & 0x7fffff) >>> 13) : Math.round(Math.abs(value) / 2 ** -24);
  return bits >>> 31 ? -magnitude : magnitude;
}

// DWAA lossy dan tidak ada di rencana 2B. `parse-exr` (port three.js)
// mengimplementasikan DCT/kuantisasi DWA sendiri; terukur terhadap OpenEXR
// 3.x lewat OIIO 3.1.17: 1440 nilai identik, 1896 selisih 1 ULP half,
// 561 selisih 2, 18 selisih 3 (dari 3915). Ambang dikunci di angka terukur;
// gerbang bit-identik kasus lain tidak disentuh.
const DWAA_MAX_HALF_ULP = 3;

describe('EXR DWAA (lossy) vs OpenImageIO', () => {
  it(`selisih <= ${DWAA_MAX_HALF_ULP} ULP half`, async () => {
    const meta = loadIoMeta('exr_half_dwaa');
    const image = await decodeImage(loadIoInput('exr_half_dwaa'));
    const expected = loadIoExpected('exr_half_dwaa');
    let worst = 0;
    for (let i = 0; i < meta.width * meta.height; i += 1) {
      for (let c = 0; c < 3; c += 1) {
        worst = Math.max(worst, Math.abs(halfOrdinal(image.rgba[i * 4 + c]!) - halfOrdinal(expected[i * 3 + c]!)));
      }
    }
    expect(worst).toBeLessThanOrEqual(DWAA_MAX_HALF_ULP);
  });
});

describe('EXR: masukan yang harus ditolak', () => {
  const invalid = (name: string) => new Uint8Array(readFileSync(join('test', 'fixtures', 'io_invalid', `${name}.exr`)));

  it.each([
    ['exr_layered', /tanpa kanal R\/G\/B atau Y \(kanal: .*diffuse\.R/],
    ['exr_mixed_types', /tipe piksel campuran/],
    ['exr_luma_chroma', /luminance-chroma/],
    ['exr_b44', /B44/],
  ])('%s', async (name, reason) => {
    const error = (await decodeImage(invalid(name)).catch((e: unknown) => e)) as DecodeError;
    expect(error).toBeInstanceOf(DecodeError);
    expect(error.format).toBe('exr');
    expect(error.reason).toMatch(reason);
  });
});

describe('EXR: alpha', () => {
  it('float RGBA membawa alpha', async () => {
    const image = await decodeImage(loadIoInput('exr_float_rgba_zip'));
    const alpha = Array.from({ length: image.width * image.height }, (_, i) => image.rgba[i * 4 + 3]!);
    expect(Math.min(...alpha)).toBe(0);
    expect(Math.max(...alpha)).toBe(1);
  });
});
