import { describe, it, expect } from 'vitest';
import { decodeImage, DecodeError } from '../../src/io';
import { describeBitIdenticalDecoder } from './codecGates';
import { loadIoInput, loadIoMeta } from './ioFixtures';

describe('TIFF vs tifffile', () => {
  describeBitIdenticalDecoder('tiff', {
    suggestedColorSpace: (name) => (name.includes('float') ? 'Linear Rec.709' : 'sRGB'),
    encoding: (name) => (name.includes('float') ? 'linear' : 'encoded'),
  });
});

describe('TIFF: alpha dan masukan tidak sah', () => {
  it('RGBA 16-bit membawa alpha tak terasosiasi', async () => {
    const image = await decodeImage(loadIoInput('tiff_rgba16'));
    const meta = loadIoMeta('tiff_rgba16');
    const alpha = Array.from({ length: meta.width * meta.height }, (_, i) => image.rgba[i * 4 + 3]!);
    expect(Math.min(...alpha)).toBe(0);
    expect(Math.max(...alpha)).toBe(1);
  });

  // Tag Compression IFD0 ditimpa: tifffile menaruh IFD di offset 8.
  function withCompression(value: number): Uint8Array {
    const bytes = loadIoInput('tiff_rgb8').slice();
    const view = new DataView(bytes.buffer);
    const ifd = view.getUint32(4, true);
    for (let i = 0; i < view.getUint16(ifd, true); i += 1) {
      const e = ifd + 2 + i * 12;
      if (view.getUint16(e, true) === 259) view.setUint16(e + 8, value, true);
    }
    return bytes;
  }

  it('kompresi tak didukung (JPEG-in-TIFF, 7) ditolak, bukan piksel nol', async () => {
    const error = (await decodeImage(withCompression(7)).catch((e: unknown) => e)) as DecodeError;
    expect(error).toBeInstanceOf(DecodeError);
    expect(error.format).toBe('tiff');
    expect(error.reason).toMatch(/kompresi TIFF 7/);
  });

  it('BigTIFF ditolak dengan alasan jelas', async () => {
    const bytes = new Uint8Array(16);
    bytes.set([0x49, 0x49, 0x2b, 0x00, 0x08, 0x00, 0x00, 0x00]);
    const error = (await decodeImage(bytes).catch((e: unknown) => e)) as DecodeError;
    expect(error).toBeInstanceOf(DecodeError);
    expect(error.reason).toMatch(/BigTIFF/);
  });
});
