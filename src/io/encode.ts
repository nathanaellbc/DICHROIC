/**
 * Encoder ekspor (spec Fase 2 §5): PNG 8/16-bit (`fast-png`) dan TIFF 16-bit
 * (`tiffWriter.ts`). Masukan `rgb_out` 3 kanal rapat yang sudah ter-encode di
 * `outputColorSpace`; tidak ada konversi warna di sini. Profil ICC colour
 * space keluaran dan EXIF asli disematkan bila diberikan (`iCCP`/`eXIf` untuk
 * PNG, tag 34675/34665 untuk TIFF).
 */
import { encode } from 'fast-png';
import { zlibSync } from 'fflate';
import { encodeTiff16 as writeTiff16 } from './tiffWriter';
import type { TiffExtras } from './tiffWriter';

export interface PngExtras {
  icc?: Uint8Array;
  /** Nama profil di `iCCP` (1..79 byte Latin-1). */
  iccName?: string;
  /** Struktur TIFF EXIF (`rewriteExif`). */
  exif?: Uint8Array;
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** Sisipkan `iCCP`/`eXIf` tepat setelah IHDR (keduanya wajib sebelum IDAT). */
function withPngExtras(png: Uint8Array, extras: PngExtras): Uint8Array {
  const chunks: Uint8Array[] = [];
  if (extras.icc) {
    const name = (extras.iccName ?? 'ICC Profile').replace(/[^\x20-\x7e]/g, '').slice(0, 79) || 'ICC Profile';
    const body = new Uint8Array(name.length + 2);
    for (let i = 0; i < name.length; i += 1) body[i] = name.charCodeAt(i);
    const z = zlibSync(extras.icc, { level: 9 });
    const data = new Uint8Array(body.length + z.length);
    data.set(body); // nama, NUL, metode 0
    data.set(z, body.length);
    chunks.push(pngChunk('iCCP', data));
  }
  if (extras.exif) chunks.push(pngChunk('eXIf', extras.exif));
  if (chunks.length === 0) return png;
  const ihdrEnd = 8 + 12 + new DataView(png.buffer, png.byteOffset).getUint32(8);
  const out = new Uint8Array(png.length + chunks.reduce((n, c) => n + c.length, 0));
  out.set(png.subarray(0, ihdrEnd));
  let at = ihdrEnd;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  out.set(png.subarray(ihdrEnd), at);
  return out;
}

/**
 * Clamp ke [0,1] lalu bulatkan ke bilangan bulat terdekat (`round(v * max)`,
 * setengah dibulatkan ke atas). NaN -> 0, +Inf -> max, -Inf -> 0: nilai di
 * luar rentang tidak boleh membungkus (wrap-around) seperti konversi integer
 * mentah (Review Focus #5 rencana 2B).
 */
export function quantize(rgb: Float32Array, bits: 8 | 16): Uint8Array | Uint16Array {
  const max = bits === 8 ? 255 : 65535;
  const out = bits === 8 ? new Uint8Array(rgb.length) : new Uint16Array(rgb.length);
  for (let i = 0; i < rgb.length; i += 1) {
    const v = rgb[i]!;
    out[i] = v > 0 ? (v >= 1 ? max : Math.round(v * max)) : 0; // `v > 0` salah untuk NaN
  }
  return out;
}

function checkSize(rgb: Float32Array, width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`dimensi tidak sah: ${width}x${height}`);
  }
  if (rgb.length !== width * height * 3) {
    throw new RangeError(`butuh ${width * height * 3} nilai RGB untuk ${width}x${height}, diterima ${rgb.length}`);
  }
}

export function encodePng(rgb: Float32Array, width: number, height: number, bits: 8 | 16, extras: PngExtras = {}): Uint8Array {
  checkSize(rgb, width, height);
  return withPngExtras(encode({ width, height, data: quantize(rgb, bits), depth: bits, channels: 3 }), extras);
}

export function encodeTiff16(rgb: Float32Array, width: number, height: number, extras: TiffExtras = {}): Uint8Array {
  checkSize(rgb, width, height);
  return writeTiff16(quantize(rgb, 16) as Uint16Array, width, height, extras);
}
