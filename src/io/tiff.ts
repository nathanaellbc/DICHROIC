/**
 * Decoder TIFF baseline+ (spec Fase 2 §5): IFD pertama, strip atau tile,
 * planar 1/2, kompresi none/LZW/Deflate/PackBits, predictor horizontal (2)
 * dan floating-point (3), sampel uint 8/16/32 dan float 16/32/64, photometric
 * WhiteIsZero/BlackIsZero/RGB/palet, alpha dari ExtraSamples.
 *
 * Integer -> ter-encode, disarankan `sRGB`; float -> linear, disarankan
 * `Linear Rec.709` (rencana 2B Task 3). Tag Orientation dan deskripsi ICC
 * dibaca `decodeImage` (`metadata.ts`), bukan di sini.
 *
 * Kenapa bukan `utif2` (rencana awal): pustaka itu mengembalikan piksel nol
 * tanpa galat untuk kompresi yang tidak dikenalnya, tidak membalik byte float
 * big-endian, menolak planar 2 hanya lewat log, mencetak `console.log` untuk
 * setiap berkas ber-tile, dan membaca offset strip di luar berkas tanpa
 * mengeluh. Setiap kegagalan itu adalah gambar salah yang diam-diam, jadi
 * pembaca ini ditulis sendiri; dekompresi Deflate tetap memakai `fflate`.
 */
import { unzlibSync } from 'fflate';
import type { DecodedImage } from './decoded';
import { assertImageBudget, IMAGE_BLOCK_BUDGET } from './budget';

const T = {
  width: 256, height: 257, bitsPerSample: 258, compression: 259, photometric: 262,
  stripOffsets: 273, samplesPerPixel: 277, rowsPerStrip: 278, stripByteCounts: 279,
  planarConfig: 284, predictor: 317, colorMap: 320, tileWidth: 322, tileLength: 323,
  tileOffsets: 324, tileByteCounts: 325, extraSamples: 338, sampleFormat: 339,
} as const;

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4, 16: 8 };
const DECODE_TAGS = new Set<number>(Object.values(T));

/** Batas piksel: header rusak tidak boleh memicu alokasi raksasa. */
export const TIFF_MAX_PIXELS = 250_000_000;

class Reader {
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array, readonly le: boolean) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  check(at: number, size: number): void {
    if (at < 0 || at + size > this.bytes.length) throw new Error('struktur TIFF menunjuk ke luar berkas (terpotong?)');
  }
  u16(at: number): number {
    this.check(at, 2);
    return this.view.getUint16(at, this.le);
  }
  u32(at: number): number {
    this.check(at, 4);
    return this.view.getUint32(at, this.le);
  }
}

type Tags = Map<number, number[]>;

function readIfd(r: Reader, offset: number): Tags {
  const count = r.u16(offset);
  const tags: Tags = new Map();
  for (let i = 0; i < count; i += 1) {
    const e = offset + 2 + i * 12;
    const tag = r.u16(e);
    if (!DECODE_TAGS.has(tag)) continue;
    const type = r.u16(e + 2);
    const n = r.u32(e + 4);
    if (n > 1_000_000) throw new Error('TIFF metadata exceeds the decoding memory limit');
    const size = TYPE_SIZE[type];
    if (size === undefined) continue; // tipe tak dikenal: tag diabaikan (TIFF 6 §2)
    const at = size * n <= 4 ? e + 8 : r.u32(e + 8);
    r.check(at, size * n);
    // Hanya tag numerik yang dibaca; teks/biner cukup ditandai ada.
    const values: number[] = [];
    if (type === 3 || type === 8) for (let k = 0; k < n; k += 1) values.push(r.u16(at + k * 2));
    else if (type === 4 || type === 9 || type === 13) for (let k = 0; k < n; k += 1) values.push(r.u32(at + k * 4));
    else if (type === 1) for (let k = 0; k < n; k += 1) values.push(r.bytes[at + k]!);
    tags.set(tag, values);
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Dekompresi

function lzwDecode(src: Uint8Array, expected: number): Uint8Array {
  if (src.length >= 2 && src[0] === 0 && (src[1]! & 1) === 1) {
    throw new Error('LZW gaya lama (LSB-first, pra-TIFF 6) belum didukung');
  }
  const out = new Uint8Array(expected);
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const length = new Int32Array(4096);
  for (let i = 0; i < 256; i += 1) {
    suffix[i] = i;
    first[i] = i;
    length[i] = 1;
  }
  let o = 0;
  let bitPos = 0;
  const totalBits = src.length * 8;
  let width = 9;
  let next = 258;
  let prev = -1;

  const emit = (code: number): void => {
    const len = length[code]!;
    let end = o + len;
    if (end > expected) end = expected; // data lebih panjang dari strip: sisanya dibuang
    for (let c = code, p = o + len - 1; p >= o; p -= 1) {
      if (p < end) out[p] = suffix[c]!;
      c = prefix[c]!;
    }
    o += len;
  };

  while (o < expected && bitPos + width <= totalBits) {
    // Baca `width` (9..12) bit MSB-first dari jendela 24 bit.
    const at = bitPos >> 3;
    const window = (src[at]! << 16) | ((src[at + 1] ?? 0) << 8) | (src[at + 2] ?? 0);
    const code = (window >>> (24 - width - (bitPos & 7))) & ((1 << width) - 1);
    bitPos += width;
    if (code === 257) break;
    if (code === 256) {
      width = 9;
      next = 258;
      prev = -1;
      continue;
    }
    if (prev === -1) {
      if (code > 255) throw new Error('kode LZW tidak sah');
      emit(code);
      prev = code;
      continue;
    }
    let firstChar: number;
    if (code < next) {
      emit(code);
      firstChar = first[code]!;
    } else if (code === next) {
      firstChar = first[prev]!;
      emit(prev); // KwKwK: string(prev) + karakter pertamanya
      if (o < expected) out[o] = firstChar;
      o += 1;
    } else {
      throw new Error('kode LZW tidak sah');
    }
    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = firstChar;
      first[next] = first[prev]!;
      length[next] = length[prev]! + 1;
      next += 1;
    }
    // "Early change" TIFF: lebar naik satu kode lebih awal.
    if (next >= (1 << width) - 1 && width < 12) width += 1;
    prev = code;
  }
  if (o < expected) throw new Error('data LZW terpotong');
  return out;
}

function packBitsDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let i = 0;
  let o = 0;
  while (o < expected && i < src.length) {
    const n = (src[i]! << 24) >> 24;
    i += 1;
    if (n >= 0) {
      const count = n + 1;
      if (i + count > src.length) break;
      out.set(src.subarray(i, i + Math.min(count, expected - o)), o);
      i += count;
      o += count;
    } else if (n !== -128) {
      const count = 1 - n;
      if (i >= src.length) break;
      out.fill(src[i]!, o, Math.min(o + count, expected));
      i += 1;
      o += count;
    }
  }
  if (o < expected) throw new Error('data PackBits terpotong');
  return out;
}

function decompress(compression: number, src: Uint8Array, expected: number): Uint8Array {
  switch (compression) {
    case 1:
      if (src.length < expected) throw new Error('data strip/tile terpotong');
      return src.subarray(0, expected);
    case 5:
      return lzwDecode(src, expected);
    case 8:
    case 32946: {
      // An explicit output buffer disables fflate's automatic expansion.
      // One sentinel byte also detects data larger than the declared block.
      const out = unzlibSync(src, { out: new Uint8Array(expected + 1) });
      if (out.length !== expected) throw new Error('data Deflate length does not match the strip/tile');
      return out;
    }
    case 32773:
      return packBitsDecode(src, expected);
    default:
      throw new Error(`kompresi TIFF ${compression} belum didukung`);
  }
}

// ---------------------------------------------------------------------------
// Predictor

function undoHorizontal(chunk: Uint8Array, rows: number, rowSamples: number, stride: number, bytesPerSample: number, le: boolean): void {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  for (let y = 0; y < rows; y += 1) {
    const base = y * rowSamples;
    for (let i = stride; i < rowSamples; i += 1) {
      const at = (base + i) * bytesPerSample;
      const prevAt = (base + i - stride) * bytesPerSample;
      if (bytesPerSample === 1) chunk[at] = (chunk[at]! + chunk[prevAt]!) & 0xff;
      else if (bytesPerSample === 2) view.setUint16(at, (view.getUint16(at, le) + view.getUint16(prevAt, le)) & 0xffff, le);
      else view.setUint32(at, (view.getUint32(at, le) + view.getUint32(prevAt, le)) >>> 0, le);
    }
  }
}

/**
 * Predictor floating-point (Adobe Photoshop TN3, `fpAcc` libtiff): selisih
 * byte horizontal ber-stride `stride`, lalu byte tiap sampel disusun ulang
 * dari bidang "MSB dulu". Hasilnya ditulis dalam urutan byte berkas (`le`)
 * supaya pembacaan sampel berikutnya seragam.
 */
function undoFloatingPoint(chunk: Uint8Array, rows: number, rowSamples: number, stride: number, bytesPerSample: number, le: boolean): void {
  const rowBytes = rowSamples * bytesPerSample;
  const tmp = new Uint8Array(rowBytes);
  for (let y = 0; y < rows; y += 1) {
    const row = chunk.subarray(y * rowBytes, (y + 1) * rowBytes);
    for (let i = stride; i < rowBytes; i += 1) row[i] = (row[i]! + row[i - stride]!) & 0xff;
    tmp.set(row);
    for (let k = 0; k < rowSamples; k += 1) {
      for (let b = 0; b < bytesPerSample; b += 1) {
        const msbFirst = tmp[b * rowSamples + k]!;
        row[k * bytesPerSample + (le ? bytesPerSample - 1 - b : b)] = msbFirst;
      }
    }
  }
}

// ---------------------------------------------------------------------------

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

function first(tags: Tags, tag: number, fallback?: number): number {
  const v = tags.get(tag)?.[0] ?? fallback;
  if (v === undefined) throw new Error(`tag TIFF ${tag} wajib tapi tidak ada`);
  return v;
}

export function decodeTiff(bytes: Uint8Array, name?: string): DecodedImage {
  if (bytes.length < 8) throw new Error('berkas terpotong');
  const le = bytes[0] === 0x49;
  const r = new Reader(bytes, le);
  const magic = r.u16(2);
  if (magic === 43) throw new Error('BigTIFF belum didukung');
  if (magic !== 42) throw new Error('header TIFF tidak sah');
  const tags = readIfd(r, r.u32(4));

  const width = first(tags, T.width);
  const height = first(tags, T.height);
  if (width === 0 || height === 0) throw new Error('dimensi 0');
  if (width * height > TIFF_MAX_PIXELS) throw new Error(`${width}x${height} melebihi batas ${TIFF_MAX_PIXELS / 1e6} MP`);
  const spp = first(tags, T.samplesPerPixel, 1);
  const bpsAll = tags.get(T.bitsPerSample) ?? [1];
  const bps = bpsAll[0]!;
  if (bpsAll.some((b) => b !== bps)) throw new Error('BitsPerSample berbeda antar kanal belum didukung');
  const sampleFormat = first(tags, T.sampleFormat, 1);
  const compression = first(tags, T.compression, 1);
  if (![1, 5, 8, 32946, 32773].includes(compression)) throw new Error(`kompresi TIFF ${compression} belum didukung`);
  const photometric = first(tags, T.photometric, spp >= 3 ? 2 : 1);
  const planar = first(tags, T.planarConfig, 1);
  const predictor = first(tags, T.predictor, 1);

  const isFloat = sampleFormat === 3;
  if (sampleFormat !== 1 && !isFloat) throw new Error(`SampleFormat ${sampleFormat} belum didukung`);
  if (isFloat ? ![16, 32, 64].includes(bps) : ![8, 16, 32].includes(bps)) {
    throw new Error(`${bps}-bit ${isFloat ? 'float' : 'integer'} belum didukung`);
  }
  let colorChannels: number;
  if (photometric === 0 || photometric === 1) colorChannels = 1;
  else if (photometric === 2) colorChannels = 3;
  else if (photometric === 3) colorChannels = 1;
  else throw new Error(`PhotometricInterpretation ${photometric} (mis. CMYK/YCbCr/Lab) belum didukung`);
  if (spp < colorChannels || spp > colorChannels + 1) throw new Error('Unsupported SamplesPerPixel channel layout');
  assertImageBudget(width, height);
  if (photometric === 3 && (isFloat || bps > 16)) throw new Error('TIFF palet harus integer 8/16-bit');
  if (photometric === 0 && isFloat) throw new Error('WhiteIsZero float tidak didukung');
  if (planar !== 1 && planar !== 2) throw new Error(`PlanarConfiguration ${planar} tidak sah`);
  if (predictor === 2 && isFloat) throw new Error('predictor horizontal pada float tidak didukung');
  if (predictor === 3 && !isFloat) throw new Error('predictor floating-point pada integer tidak sah');
  if (predictor !== 1 && predictor !== 2 && predictor !== 3) throw new Error(`Predictor ${predictor} belum didukung`);
  // ExtraSamples 1 (alpha terasosiasi) atau 2 (tak terasosiasi); 0 = data lain.
  const extra = tags.get(T.extraSamples)?.[0];
  const hasAlpha = spp > colorChannels && (extra === 1 || extra === 2);

  const bytesPerSample = bps / 8;
  const tiled = tags.has(T.tileWidth);
  const cw = tiled ? first(tags, T.tileWidth) : width;
  const ch = tiled ? first(tags, T.tileLength) : Math.min(first(tags, T.rowsPerStrip, 0xffffffff), height);
  if (cw === 0 || ch === 0) throw new Error('ukuran strip/tile 0');
  const offsets = tags.get(tiled ? T.tileOffsets : T.stripOffsets);
  if (!offsets) throw new Error('offset data gambar tidak ada');
  const counts = tags.get(tiled ? T.tileByteCounts : T.stripByteCounts);
  const across = Math.ceil(width / cw);
  const down = Math.ceil(height / ch);
  const planes = planar === 2 ? spp : 1;
  const chunkSamples = planar === 2 ? 1 : spp;
  if (offsets.length < across * down * planes) throw new Error('jumlah strip/tile kurang dari yang dibutuhkan');

  // Validate every block before allocating the full sample image.
  for (let index = 0; index < across * down * planes; index += 1) {
    const ty = Math.floor(index / across) % down;
    const rows = tiled ? ch : Math.min(ch, height - ty * ch);
    const expected = rows * cw * chunkSamples * bytesPerSample;
    if (!Number.isSafeInteger(expected) || ((compression !== 1 || predictor !== 1) && expected > IMAGE_BLOCK_BUDGET)) throw new Error('TIFF strip/tile exceeds the decoding memory limit');
    const count = counts?.[index] ?? (compression === 1 ? expected : undefined);
    if (count === undefined) throw new Error('StripByteCounts tidak ada');
    r.check(offsets[index]!, count);
    if (compression === 1 && count < expected) throw new Error('data strip/tile terpotong');
  }

  // Normalize each block directly into the final image. A full Float64
  // sample image would more than triple decoder memory for ordinary RGB.
  const map = tags.get(T.colorMap);
  const entries = 2 ** bps;
  if (photometric === 3 && (!map || map.length < entries * 3)) throw new Error('ColorMap palet tidak ada atau terlalu pendek');
  const n = width * height;
  const rgba = new Float32Array(n * 4);
  if (!hasAlpha) for (let i = 0; i < n; i += 1) rgba[i * 4 + 3] = 1;
  const maxValue = 2 ** bps - 1;
  const norm = (v: number) => (isFloat ? v : v / maxValue);
  for (let plane = 0; plane < planes; plane += 1) {
    for (let ty = 0; ty < down; ty += 1) {
      for (let tx = 0; tx < across; tx += 1) {
        const index = plane * across * down + ty * across + tx;
        const rows = tiled ? ch : Math.min(ch, height - ty * ch);
        const rowSamples = cw * chunkSamples;
        const expected = rows * rowSamples * bytesPerSample;
        const off = offsets[index]!;
        const count = counts?.[index] ?? (compression === 1 ? expected : undefined);
        if (count === undefined) throw new Error('StripByteCounts tidak ada');
        r.check(off, count);
        // Salinan: predictor menulis di tempat, dan berkas masukan tidak boleh berubah.
        const decoded = decompress(compression, bytes.subarray(off, off + count), expected);
        const chunk = compression === 1 && predictor !== 1 ? decoded.slice() : decoded;
        if (predictor === 2) undoHorizontal(chunk, rows, rowSamples, chunkSamples, bytesPerSample, le);
        if (predictor === 3) undoFloatingPoint(chunk, rows, rowSamples, chunkSamples, bytesPerSample, le);

        const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        for (let y = 0; y < rows; y += 1) {
          const iy = ty * ch + y;
          if (iy >= height) break;
          for (let x = 0; x < cw; x += 1) {
            const ix = tx * cw + x;
            if (ix >= width) break;
            for (let s = 0; s < chunkSamples; s += 1) {
              const at = ((y * cw + x) * chunkSamples + s) * bytesPerSample;
              let v: number;
              if (isFloat) {
                v = bps === 16 ? halfToFloat(view.getUint16(at, le)) : bps === 32 ? view.getFloat32(at, le) : view.getFloat64(at, le);
              } else {
                v = bps === 8 ? chunk[at]! : bps === 16 ? view.getUint16(at, le) : view.getUint32(at, le);
              }
              const channel = planar === 2 ? plane : s;
              const pixel = (iy * width + ix) * 4;
              if (channel < colorChannels) {
                if (photometric === 3) {
                  rgba[pixel] = map![v]! / 65535;
                  rgba[pixel + 1] = map![entries + v]! / 65535;
                  rgba[pixel + 2] = map![2 * entries + v]! / 65535;
                } else if (colorChannels === 1) {
                  const value = norm(photometric === 0 ? maxValue - v : v);
                  rgba[pixel] = value; rgba[pixel + 1] = value; rgba[pixel + 2] = value;
                } else rgba[pixel + channel] = norm(v);
              } else if (hasAlpha) rgba[pixel + 3] = norm(v);
            }
          }
        }
      }
    }
  }

  return {
    width,
    height,
    rgba,
    suggestedColorSpace: isFloat ? 'Linear Rec.709' : 'sRGB',
    encoding: isFloat ? 'linear' : 'encoded',
    source: { format: 'tiff', bitDepth: photometric === 3 ? 16 : bps, ...(name === undefined ? {} : { name }) },
  };
}
