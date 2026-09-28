/**
 * Decoder PNG (`fast-png`, MIT): 1/2/4/8/16-bit, grayscale (+alpha), RGB(A),
 * dan palet. Keluaran ter-encode, disarankan `sRGB` (spec Fase 2 §5); chunk
 * `gAMA`/`iCCP`/`sRGB` belum dibaca.
 *
 * `fast-png` membiarkan grayscale di bawah 8-bit tetap terkemas per baris,
 * jadi dibongkar di sini; palet diserahkan ke `convertIndexedToRgb` pustaka.
 */
import { convertIndexedToRgb, decode } from 'fast-png';
import type { DecodedImage } from './decoded';
import { interleavedToRgba } from './pixels';

function unpackLowBitGray(packed: ArrayLike<number>, width: number, height: number, depth: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const bytesPerLine = Math.ceil((width * depth) / 8);
  const mask = (1 << depth) - 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const bit = x * depth;
      const byte = packed[y * bytesPerLine + (bit >> 3)]!;
      out[y * width + x] = (byte >> (8 - depth - (bit & 7))) & mask;
    }
  }
  return out;
}

export function decodePng(bytes: Uint8Array, name?: string): DecodedImage {
  const png = decode(bytes, { checkCrc: true });
  const { width, height, depth } = png;
  let rgba: Float32Array;
  let bitDepth: number = depth;
  if (png.palette) {
    const channels = png.palette[0]?.length ?? 3;
    rgba = interleavedToRgba(convertIndexedToRgb(png), width, height, channels, 255);
    bitDepth = 8;
  } else if (depth < 8) {
    if (png.channels !== 1) throw new Error(`PNG ${depth}-bit dengan ${png.channels} kanal tidak sah`);
    rgba = interleavedToRgba(unpackLowBitGray(png.data, width, height, depth), width, height, 1, (1 << depth) - 1);
  } else {
    rgba = interleavedToRgba(png.data, width, height, png.channels, depth === 16 ? 65535 : 255);
  }
  return {
    width,
    height,
    rgba,
    suggestedColorSpace: 'sRGB',
    encoding: 'encoded',
    source: { format: 'png', bitDepth, ...(name === undefined ? {} : { name }) },
  };
}
