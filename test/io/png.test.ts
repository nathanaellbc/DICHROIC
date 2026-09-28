import { describe, it, expect } from 'vitest';
import { decodeImage, DecodeError } from '../../src/io';
import { describeBitIdenticalDecoder } from './codecGates';
import { loadIoInput } from './ioFixtures';

describe('PNG vs Pillow/OIIO', () => {
  describeBitIdenticalDecoder('png', { suggestedColorSpace: () => 'sRGB', encoding: 'encoded' });
});

describe('PNG: alpha dan kerusakan', () => {
  it('RGBA membawa alpha ternormalisasi; RGB tanpa alpha -> 1', async () => {
    const rgba = await decodeImage(loadIoInput('png_rgba8'));
    const alphas = new Set(Array.from({ length: rgba.width * rgba.height }, (_, i) => rgba.rgba[i * 4 + 3]!));
    expect(alphas.size).toBeGreaterThan(10);
    expect(Math.min(...alphas)).toBe(0);
    expect(Math.max(...alphas)).toBe(1);

    const rgb = await decodeImage(loadIoInput('png_rgb16'));
    for (let i = 0; i < rgb.width * rgb.height; i += 1) expect(rgb.rgba[i * 4 + 3]).toBe(1);
  });

  it('CRC rusak -> DecodeError("png")', async () => {
    const bytes = loadIoInput('png_rgb8').slice();
    bytes[40] = bytes[40]! ^ 0xff; // di dalam chunk IDAT pertama
    const error = await decodeImage(bytes).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecodeError);
    expect((error as DecodeError).format).toBe('png');
  });
});
