import { describe, it, expect } from 'vitest';
import { decodeImage, DecodeError } from '../../src/io';
import { describeBitIdenticalDecoder } from './codecGates';
import { loadIoInput } from './ioFixtures';

// Gerbang Task 2 rencana 2B menargetkan <= 2/255 untuk JPEG karena `jpeg-js`
// dan libjpeg-turbo berbeda di IDCT dan upsampling. Terukur 125/255 pada
// 4:2:0 -- jadi decodernya diganti (src/io/jpegDecoder.ts, meniru
// libjpeg-turbo) dan gerbangnya menjadi bit-identik, sama seperti PNG.
describe('JPEG vs Pillow (libjpeg-turbo)', () => {
  describeBitIdenticalDecoder('jpeg', { suggestedColorSpace: () => 'sRGB', encoding: 'encoded' });
});

describe('JPEG: masukan tidak sah', () => {
  it('JPEG aritmetika (SOF9) ditolak dengan alasan jelas', async () => {
    const bytes = loadIoInput('jpeg_baseline_q90').slice();
    const sof = bytes.findIndex((b, i) => b === 0xff && bytes[i + 1] === 0xc0);
    bytes[sof + 1] = 0xc9;
    const error = (await decodeImage(bytes).catch((e: unknown) => e)) as DecodeError;
    expect(error).toBeInstanceOf(DecodeError);
    expect(error.format).toBe('jpeg');
    expect(error.reason).toMatch(/SOF9/);
  });

  it('hanya SOI -> DecodeError', async () => {
    const error = await decodeImage(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecodeError);
  });
});
