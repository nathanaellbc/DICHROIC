/**
 * Decoder PNG (`fast-png`, MIT): 1/2/4/8/16-bit, grayscale (+alpha), RGB(A),
 * dan palet. Keluaran ter-encode, disarankan `sRGB` (spec Fase 2 §5); `eXIf`
 * dan deskripsi `iCCP` dibaca `decodeImage` (`metadata.ts`), `gAMA` tidak.
 *
 * `fast-png` membiarkan grayscale di bawah 8-bit tetap terkemas per baris,
 * jadi dibongkar di sini; palet diserahkan ke `convertIndexedToRgb` pustaka.
 */
import { convertIndexedToRgb, decode } from 'fast-png';
import { Unzlib } from 'fflate';
import type { DecodedImage } from './decoded';
import { interleavedToRgba } from './pixels';
import { assertImageBudget } from './budget';

function pixelChunks(bytes: Uint8Array, width: number, height: number): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept = [bytes.subarray(0, 8)];
  let inflated = 0;
  // Eight bytes per pixel covers RGBA16, plus all seven Adam7 filter rows.
  const limit = width * height * 8 + height * 7 + 7;
  const stream = new Unzlib((chunk) => {
    inflated += chunk.length;
    if (inflated > limit) throw new Error('PNG expansion exceeds the decoding memory limit');
  });
  let ended = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('PNG chunk is truncated');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) kept.push(bytes.subarray(offset, end));
    if (type === 'IDAT') {
      for (let pos = offset + 8; pos < end - 4; pos += 1024) stream.push(bytes.subarray(pos, Math.min(pos + 1024, end - 4)), false);
    }
    if (type === 'IEND') { ended = true; break; }
    offset = end;
  }
  if (!ended) throw new Error('PNG end chunk is missing');
  stream.push(new Uint8Array(0), true);
  // Metadata is handled separately; do not let fast-png inflate unneeded text,
  // ICC or animation chunks with no allocation limit.
  const result = new Uint8Array(kept.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of kept) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

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
  if (bytes.length < 33) throw new Error('PNG header is truncated');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assertImageBudget(header.getUint32(16), header.getUint32(20), 24);
  const png = decode(pixelChunks(bytes, header.getUint32(16), header.getUint32(20)), { checkCrc: true });
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
