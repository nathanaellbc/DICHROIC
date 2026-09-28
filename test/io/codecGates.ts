import { describe, it, expect } from 'vitest';
import { decodeImage, DecodeError, type ImageFormat } from '../../src/io';
import { ioCases, loadIoExpected, loadIoInput, loadIoMeta, mismatches } from './ioFixtures';

/**
 * Gerbang bersama decoder lossless-terhadap-oracle: setiap fixture
 * `test/fixtures/io/<case>` berformat `format` harus bit-identik dengan
 * array oracle Python (`tools/gen_io_reference.py`), dan versi terpotongnya
 * harus melempar `DecodeError` yang menyebut format itu.
 */
export function describeBitIdenticalDecoder(
  format: ImageFormat,
  expectations: {
    suggestedColorSpace: (name: string) => string;
    encoding: (name: string) => 'encoded' | 'linear';
    /** Kasus lossy yang punya gerbang sendiri (terukur, dikunci) di berkas test format. */
    notBitIdentical?: readonly string[];
  },
): void {
  const cases = ioCases(format).filter((name) => !expectations.notBitIdentical?.includes(name));

  it('fixture ada', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  describe.each(cases)('%s', (name) => {
    it('bit-identik dengan oracle', async () => {
      const meta = loadIoMeta(name);
      const image = await decodeImage(loadIoInput(name), `${name}.${format}`);
      expect([image.width, image.height]).toEqual([meta.width, meta.height]);
      expect(image.rgba.length).toBe(meta.width * meta.height * 4);
      expect(mismatches(image.rgba, loadIoExpected(name)), meta.oracle).toBe(0);
      expect(image.source).toEqual({ format, bitDepth: meta.bitDepth, name: `${name}.${format}` });
      expect(image.suggestedColorSpace).toBe(expectations.suggestedColorSpace(name));
      expect(image.encoding).toBe(expectations.encoding(name));
    });

    it('berkas terpotong -> DecodeError', async () => {
      const bytes = loadIoInput(name);
      for (const keep of [Math.floor(bytes.length / 2), bytes.length - 3]) {
        const error = await decodeImage(bytes.subarray(0, keep)).catch((e: unknown) => e);
        expect(error, `dipotong ke ${keep} byte`).toBeInstanceOf(DecodeError);
        expect((error as DecodeError).format).toBe(format);
      }
    });
  });
}
