/**
 * Penulis TIFF baseline RGB 16-bit tak terkompresi (spec Fase 2 §5: tanpa
 * dependensi). Little-endian, satu strip, tag wajib TIFF 6 baseline
 * (termasuk resolusi 72 dpi) plus `Software`.
 */
import { DICHROIC_VERSION } from '../version';

const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
const ASCII = 2;

interface Entry {
  tag: number;
  type: number;
  values: number[] | Uint8Array;
}

/** `samples`: RGB 16-bit rapat, `width * height * 3`. */
export function encodeTiff16(samples: Uint16Array, width: number, height: number): Uint8Array {
  const pixelBytes = width * height * 6;
  const software = new TextEncoder().encode(`DICHROIC ${DICHROIC_VERSION}\0`);
  const entries: Entry[] = [
    { tag: 256, type: LONG, values: [width] },
    { tag: 257, type: LONG, values: [height] },
    { tag: 258, type: SHORT, values: [16, 16, 16] },
    { tag: 259, type: SHORT, values: [1] }, // tanpa kompresi
    { tag: 262, type: SHORT, values: [2] }, // RGB
    { tag: 273, type: LONG, values: [0] }, // StripOffsets, diisi di bawah
    { tag: 277, type: SHORT, values: [3] },
    { tag: 278, type: LONG, values: [height] },
    { tag: 279, type: LONG, values: [pixelBytes] },
    { tag: 282, type: RATIONAL, values: [72, 1] },
    { tag: 283, type: RATIONAL, values: [72, 1] },
    { tag: 284, type: SHORT, values: [1] }, // chunky
    { tag: 296, type: SHORT, values: [2] }, // inci
    { tag: 305, type: ASCII, values: software },
  ];
  const size = (e: Entry) => (e.type === SHORT ? 2 : e.type === RATIONAL ? 4 : e.type === ASCII ? 1 : 4) * e.values.length;

  const ifdAt = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  let extraAt = ifdAt + ifdSize;
  const extraOffsets = entries.map((e) => {
    if (size(e) <= 4) return -1;
    const at = extraAt;
    extraAt += size(e) + (size(e) & 1); // offset nilai harus genap (word boundary)
    return at;
  });
  const dataAt = extraAt;
  entries[5]!.values = [dataAt];

  const out = new Uint8Array(dataAt + pixelBytes);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49, 0x2a, 0x00]);
  view.setUint32(4, ifdAt, true);
  view.setUint16(ifdAt, entries.length, true);
  entries.forEach((e, i) => {
    const p = ifdAt + 2 + i * 12;
    view.setUint16(p, e.tag, true);
    view.setUint16(p + 2, e.type, true);
    view.setUint32(p + 4, e.type === RATIONAL ? e.values.length / 2 : e.values.length, true);
    const target = extraOffsets[i]! < 0 ? p + 8 : extraOffsets[i]!;
    if (extraOffsets[i]! >= 0) view.setUint32(p + 8, target, true);
    for (let k = 0; k < e.values.length; k += 1) {
      const v = e.values[k]!;
      if (e.type === SHORT) view.setUint16(target + k * 2, v, true);
      else if (e.type === ASCII) out[target + k] = v;
      else view.setUint32(target + k * 4, v, true);
    }
  });
  view.setUint32(ifdAt + 2 + entries.length * 12, 0, true); // tidak ada IFD berikutnya

  for (let i = 0; i < samples.length; i += 1) view.setUint16(dataAt + i * 2, samples[i]!, true);
  return out;
}
