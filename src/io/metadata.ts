/**
 * Metadata berkas yang dibaca di luar decoder piksel: tag Orientation EXIF/TIFF
 * dan deskripsi profil ICC. Decoder (`jpeg.ts`, `png.ts`, `tiff.ts`) tetap
 * mengembalikan piksel apa adanya, persis oracle Pillow/tifffile yang juga
 * tidak memutar gambar; `decodeImage` menerapkan hasil modul ini sesudahnya.
 *
 * - Orientation: JPEG APP1 `Exif`, PNG `eXIf`, TIFF IFD0 tag 274. Foto HP
 *   hampir selalu disimpan mendatar dengan tag 6/8, jadi tanpa ini potret
 *   tampil miring. RAW tidak lewat sini: LibRaw sudah memutarnya.
 * - ICC: hanya DESKRIPSI profil (`desc`) yang dibaca, lalu dipetakan ke label
 *   colour space manifest bila jelas (mis. "Display P3" dari iPhone). Itu
 *   saran, sama seperti `suggestedColorSpace` lain -- profilnya sendiri tidak
 *   diterapkan.
 */
import { inflateBounded } from './inflateBounded';
import type { DecodedImage } from './decoded';
import type { ImageFormat } from './detect';

export type Orientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface ImageMetadata {
  orientation: Orientation;
  /** Deskripsi profil ICC tersemat, bila ada. */
  iccDescription?: string;
}

const TAG_ORIENTATION = 0x0112;
const TAG_ICC_PROFILE = 0x8773;

/** Nilai tag IFD0 sebuah struktur TIFF (header `II*\0`/`MM\0*`), atau `undefined`. */
interface Ifd0 {
  orientation?: number;
  icc?: Uint8Array;
}

function readIfd0(tiff: Uint8Array): Ifd0 {
  if (tiff.length < 8) return {};
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = view.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return {};
  const le = order === 0x4949;
  const u16 = (o: number) => view.getUint16(o, le);
  const u32 = (o: number) => view.getUint32(o, le);
  if (u16(2) !== 42) return {};
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return {};
  const count = u16(ifd);
  const result: Ifd0 = {};
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const n = u32(entry + 4);
    if (tag === TAG_ORIENTATION && type === 3 && n >= 1) {
      result.orientation = u16(entry + 8);
    } else if (tag === TAG_ICC_PROFILE && (type === 7 || type === 1) && n > 4) {
      const offset = u32(entry + 8);
      if (offset + n <= tiff.length) result.icc = tiff.subarray(offset, offset + n);
    }
  }
  return result;
}

function asOrientation(value: number | undefined): Orientation {
  return value !== undefined && value >= 1 && value <= 8 ? (value as Orientation) : 1;
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let s = '';
  for (let i = start; i < start + length && i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]!);
  return s;
}

/**
 * Teks tag `desc` profil ICC: tipe `desc` (v2, ASCII) atau `mluc` (v4,
 * UTF-16BE, rekaman pertama). `undefined` bila profil rusak atau tanpa `desc`.
 */
export function iccDescription(icc: Uint8Array): string | undefined {
  if (icc.length < 132 || ascii(icc, 36, 4) !== 'acsp') return undefined;
  const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
  const tags = view.getUint32(128);
  for (let i = 0; i < tags; i += 1) {
    const entry = 132 + i * 12;
    if (entry + 12 > icc.length) return undefined;
    if (ascii(icc, entry, 4) !== 'desc') continue;
    const offset = view.getUint32(entry + 4);
    const size = view.getUint32(entry + 8);
    if (offset + Math.min(size, 12) > icc.length) return undefined;
    const type = ascii(icc, offset, 4);
    if (type === 'desc') {
      const length = view.getUint32(offset + 8);
      return ascii(icc, offset + 12, length).replace(/\0+$/, '').trim() || undefined;
    }
    if (type === 'mluc') {
      if (view.getUint32(offset + 8) < 1) return undefined;
      const length = view.getUint32(offset + 20);
      const start = offset + view.getUint32(offset + 24);
      let s = '';
      for (let o = start; o + 1 < start + length && o + 1 < icc.length; o += 2) s += String.fromCharCode(view.getUint16(o));
      return s.replace(/\0+$/, '').trim() || undefined;
    }
    return undefined;
  }
  return undefined;
}

function jpegMetadata(bytes: Uint8Array): ImageMetadata {
  let orientation: Orientation = 1;
  const iccChunks: Array<{ seq: number; data: Uint8Array }> = [];
  let o = 2;
  while (o + 4 <= bytes.length && bytes[o] === 0xff) {
    const marker = bytes[o + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      o += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // data scan: metadata sudah lewat
    const length = (bytes[o + 2]! << 8) | bytes[o + 3]!;
    const body = bytes.subarray(o + 4, Math.min(bytes.length, o + 2 + length));
    if (marker === 0xe1 && ascii(body, 0, 6) === 'Exif\0\0') {
      orientation = asOrientation(readIfd0(body.subarray(6)).orientation);
    } else if (marker === 0xe2 && ascii(body, 0, 12) === 'ICC_PROFILE\0' && body.length > 14) {
      iccChunks.push({ seq: body[12]!, data: body.subarray(14) });
    }
    o += 2 + length;
  }
  let iccText: string | undefined;
  if (iccChunks.length > 0) {
    iccChunks.sort((a, b) => a.seq - b.seq);
    const total = iccChunks.reduce((n, c) => n + c.data.length, 0);
    const icc = new Uint8Array(total);
    let at = 0;
    for (const chunk of iccChunks) {
      icc.set(chunk.data, at);
      at += chunk.data.length;
    }
    iccText = iccDescription(icc);
  }
  return { orientation, ...(iccText === undefined ? {} : { iccDescription: iccText }) };
}

function pngMetadata(bytes: Uint8Array): ImageMetadata {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let orientation: Orientation = 1;
  let iccText: string | undefined;
  let o = 8;
  while (o + 8 <= bytes.length) {
    const length = view.getUint32(o);
    const type = ascii(bytes, o + 4, 4);
    const body = bytes.subarray(o + 8, Math.min(bytes.length, o + 8 + length));
    if (type === 'eXIf') {
      orientation = asOrientation(readIfd0(body).orientation);
    } else if (type === 'iCCP') {
      const nul = body.indexOf(0);
      // nama profil (1..79 byte), NUL, metode kompresi (0 = zlib), data.
      if (nul > 0 && body[nul + 1] === 0) {
        try {
          iccText = iccDescription(inflateBounded(body.subarray(nul + 2), 4 * 1024 * 1024));
        } catch {
          iccText = undefined;
        }
      }
    } else if (type === 'IDAT' || type === 'IEND') {
      // eXIf/iCCP sah hanya sebelum IDAT.
      break;
    }
    o += 12 + length;
  }
  return { orientation, ...(iccText === undefined ? {} : { iccDescription: iccText }) };
}

function tiffMetadata(bytes: Uint8Array): ImageMetadata {
  const ifd = readIfd0(bytes);
  const iccText = ifd.icc ? iccDescription(ifd.icc) : undefined;
  return { orientation: asOrientation(ifd.orientation), ...(iccText === undefined ? {} : { iccDescription: iccText }) };
}

/** Metadata untuk format ter-encode; format lain (EXR, RAW) selalu orientasi 1. */
export function readMetadata(bytes: Uint8Array, format: ImageFormat): ImageMetadata {
  try {
    if (format === 'jpeg') return jpegMetadata(bytes);
    if (format === 'png') return pngMetadata(bytes);
    if (format === 'tiff') return tiffMetadata(bytes);
  } catch {
    // Metadata rusak tidak boleh menggagalkan berkas yang pikselnya sah.
  }
  return { orientation: 1 };
}

/**
 * Label colour space manifest yang disarankan deskripsi ICC, atau `undefined`
 * bila tidak jelas (profil kamera/monitor, Rec.2020 tanpa kurva pasti, dsb.).
 */
export function colorSpaceForIcc(description: string): string | undefined {
  const d = description.toLowerCase();
  if (/display\s*p3/.test(d)) return 'Display P3';
  if (/adobe\s*rgb|compatible with adobe/.test(d)) return 'Adobe RGB (1998)';
  if (/prophoto|romm/.test(d)) return 'ProPhoto RGB';
  if (/\bsrgb\b|iec\s*61966-2[.-]1/.test(d)) return 'sRGB';
  return undefined;
}

/**
 * Piksel RGBA diputar/dicerminkan sesuai Orientation EXIF, menghasilkan
 * gambar seperti yang dimaksud kamera. Untuk (x, y) keluaran, sumbernya:
 * 2 cermin horizontal, 3 putar 180, 4 cermin vertikal, 5 transpose,
 * 6 putar 90 searah jarum jam, 7 transverse, 8 putar 90 berlawanan.
 */
export function applyOrientation(image: DecodedImage, orientation: Orientation): DecodedImage {
  if (orientation === 1) return image;
  const { width: w, height: h, rgba } = image;
  const swap = orientation >= 5;
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const out = new Float32Array(rgba.length);
  for (let y = 0; y < oh; y += 1) {
    for (let x = 0; x < ow; x += 1) {
      let sx: number;
      let sy: number;
      switch (orientation) {
        case 2: sx = w - 1 - x; sy = y; break;
        case 3: sx = w - 1 - x; sy = h - 1 - y; break;
        case 4: sx = x; sy = h - 1 - y; break;
        case 5: sx = y; sy = x; break;
        case 6: sx = y; sy = h - 1 - x; break;
        case 7: sx = w - 1 - y; sy = h - 1 - x; break;
        default: sx = w - 1 - y; sy = x; break; // 8
      }
      const from = (sy * w + sx) * 4;
      const to = (y * ow + x) * 4;
      out[to] = rgba[from]!;
      out[to + 1] = rgba[from + 1]!;
      out[to + 2] = rgba[from + 2]!;
      out[to + 3] = rgba[from + 3]!;
    }
  }
  return { ...image, width: ow, height: oh, rgba: out };
}
