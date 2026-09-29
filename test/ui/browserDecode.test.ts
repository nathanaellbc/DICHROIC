import { describe, expect, it } from 'vitest';
import { isBrowserImage } from '../../src/ui/engine/browserDecode';

const bytes = (s: string, pad = 16) => {
  const out = new Uint8Array(Math.max(pad, s.length));
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
};

/** Kotak `ftyp` ISO-BMFF: ukuran, 'ftyp', major brand, versi, compatible brands. */
function ftyp(major: string, ...compatible: string[]): Uint8Array {
  const size = 16 + compatible.length * 4;
  const out = bytes(`\0\0\0\0ftyp${major}\0\0\0\0${compatible.join('')}`, size);
  new DataView(out.buffer).setUint32(0, size);
  return out;
}

describe('isBrowserImage', () => {
  it('mengenali HEIC/HEIF/AVIF dari brand ftyp (major atau compatible)', () => {
    expect(isBrowserImage(ftyp('heic', 'mif1', 'heic'))).toBe(true);
    expect(isBrowserImage(ftyp('avif', 'mif1'))).toBe(true);
    expect(isBrowserImage(ftyp('xxxx', 'mif1'))).toBe(true);
  });

  it('menolak ftyp video/CR3 (bukan citra HEIF)', () => {
    expect(isBrowserImage(ftyp('isom', 'mp41'))).toBe(false);
    expect(isBrowserImage(ftyp('crx ', 'isom'))).toBe(false);
  });

  it('mengenali WebP, GIF, BMP; menolak JPEG dan berkas pendek', () => {
    expect(isBrowserImage(bytes('RIFF\0\0\0\0WEBPVP8 '))).toBe(true);
    expect(isBrowserImage(bytes('GIF89a'))).toBe(true);
    expect(isBrowserImage(bytes('BM'))).toBe(true);
    expect(isBrowserImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(isBrowserImage(bytes('RIFF', 4))).toBe(false);
  });
});
