/**
 * Encoder JPEG baseline untuk ekspor, tanpa kanvas.
 *
 * Kenapa bukan `OffscreenCanvas.convertToBlob`: di iOS kanvas dibatasi
 * 16,7 MP, jadi foto iPhone 24/48 MP harus diperkecil sebelum di-encode, dan
 * kanvas tidak bisa menyematkan EXIF atau profil ICC selain sRGB/Display P3.
 * Encoder ini:
 *
 * - resolusi native tanpa batas (dibatasi hanya oleh SOF0: 65535 per sisi);
 * - YCbCr JFIF (BT.601 rentang penuh) dari sampel 8-bit yang dikuantisasi
 *   PERSIS seperti PNG 8-bit (`quantize` di encode.ts), jadi JPEG q100 dan PNG
 *   berasal dari piksel yang sama;
 * - chroma 4:4:4 (tanpa subsampling) pada kualitas >= 90, 4:2:0 di bawahnya;
 * - tabel kuantisasi Annex K dengan skala kualitas libjpeg (`jcparam.c`),
 *   jadi "kualitas 90" di sini berarti hal yang sama dengan Pillow/libjpeg;
 * - FDCT float AAN (`jfdctflt.c`), tabel Huffman standar Annex K.3;
 * - EXIF (APP1) dan ICC (APP2, dipecah per 65519 byte seperti libjpeg).
 *
 * Diproses per baris MCU: memori tambahan hanya satu strip, bukan salinan
 * gambar penuh.
 */
import { EXIF_APP1_MAX_BYTES } from './exif';

export interface JpegOptions {
  /** 1..100, skala libjpeg. */
  quality: number;
  /** Struktur TIFF EXIF (tanpa awalan `Exif\0\0`). */
  exif?: Uint8Array;
  /** Profil ICC utuh. */
  icc?: Uint8Array;
}

/** Batas isi APP1 EXIF (lihat `exif.ts`). */
export const JPEG_MAX_EXIF_BYTES = EXIF_APP1_MAX_BYTES;
const ICC_CHUNK_BYTES = 65535 - 2 - 14;
/** Kualitas mulai dari sini memakai 4:4:4. */
const FULL_CHROMA_QUALITY = 90;

// Zig-zag -> indeks natural.
const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

// Annex K.1 / K.2 (urutan natural).
const STD_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const STD_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  ...new Array<number>(32).fill(99),
];

// Annex K.3: jumlah kode per panjang 1..16, lalu nilainya.
const DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_LUMA_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];
const AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77];
const AC_CHROMA_VALUES = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa,
];

// Skala AAN (`jfdctflt.c`): koefisien keluaran FDCT float = DCT sebenarnya x 8 x s[u] x s[v].
const AAN = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379];

/** Tabel kuantisasi terskala libjpeg (`jpeg_quality_scaling` + baseline, 1..255), urutan natural. */
export function quantTable(base: readonly number[], quality: number): Uint8Array {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  return Uint8Array.from(base, (v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

/** Pengali kuantisasi untuk keluaran FDCT AAN, urutan natural. */
function divisors(qt: Uint8Array): Float32Array {
  const out = new Float32Array(64);
  for (let r = 0; r < 8; r += 1) for (let c = 0; c < 8; c += 1) out[r * 8 + c] = 1 / (qt[r * 8 + c]! * AAN[r]! * AAN[c]! * 8);
  return out;
}

interface Huffman {
  code: Uint16Array;
  size: Uint8Array;
}

function huffman(bits: readonly number[], values: readonly number[]): Huffman {
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);
  let c = 0;
  let k = 0;
  for (let len = 1; len <= 16; len += 1) {
    for (let i = 0; i < bits[len - 1]!; i += 1) {
      code[values[k]!] = c;
      size[values[k]!] = len;
      c += 1;
      k += 1;
    }
    c <<= 1;
  }
  return { code, size };
}

const HUFF = {
  dcLuma: huffman(DC_LUMA_BITS, DC_VALUES),
  acLuma: huffman(AC_LUMA_BITS, AC_LUMA_VALUES),
  dcChroma: huffman(DC_CHROMA_BITS, DC_VALUES),
  acChroma: huffman(AC_CHROMA_BITS, AC_CHROMA_VALUES),
};

/** Byte keluaran yang tumbuh sendiri. */
class Output {
  buf: Uint8Array;
  length = 0;

  constructor(initial: number) {
    this.buf = new Uint8Array(Math.max(1024, initial));
  }

  ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.length++] = v;
  }

  u16(v: number): void {
    this.ensure(2);
    this.buf[this.length++] = (v >>> 8) & 0xff;
    this.buf[this.length++] = v & 0xff;
  }

  bytes(b: ArrayLike<number>): void {
    this.ensure(b.length);
    for (let i = 0; i < b.length; i += 1) this.buf[this.length++] = b[i]!;
  }

  ascii(s: string): void {
    for (let i = 0; i < s.length; i += 1) this.u8(s.charCodeAt(i));
  }

  /** Segmen marker: FF xx, panjang (termasuk 2 byte panjang), isi. */
  segment(marker: number, parts: ReadonlyArray<ArrayLike<number> | string>): void {
    let len = 2;
    for (const p of parts) len += p.length;
    this.u8(0xff);
    this.u8(marker);
    this.u16(len);
    for (const p of parts) typeof p === 'string' ? this.ascii(p) : this.bytes(p);
  }
}

/** Penulis bit entropi dengan byte stuffing 0xFF 0x00. */
class BitWriter {
  private acc = 0;
  private count = 0;

  constructor(private readonly out: Output) {}

  /** `len` <= 16. */
  put(value: number, len: number): void {
    this.acc = (this.acc << len) | (value & ((1 << len) - 1));
    this.count += len;
    const out = this.out;
    while (this.count >= 8) {
      this.count -= 8;
      const byte = (this.acc >>> this.count) & 0xff;
      out.buf[out.length++] = byte;
      if (byte === 0xff) out.buf[out.length++] = 0;
    }
    this.acc &= (1 << this.count) - 1;
  }

  /** Isi sisa bit dengan 1 (F.1.2.3). */
  flush(): void {
    if (this.count > 0) this.put(0x7f, 8 - this.count);
  }
}

function category(v: number): number {
  let a = v < 0 ? -v : v;
  let n = 0;
  while (a) {
    n += 1;
    a >>= 1;
  }
  return n;
}

/** FDCT float AAN di tempat (`jfdctflt.c`), baris lalu kolom. */
function fdct(d: Float32Array): void {
  for (let pass = 0; pass < 2; pass += 1) {
    const step = pass === 0 ? 1 : 8;
    const stride = pass === 0 ? 8 : 1;
    for (let k = 0; k < 8; k += 1) {
      const o = k * stride;
      const d0 = d[o]!, d1 = d[o + step]!, d2 = d[o + 2 * step]!, d3 = d[o + 3 * step]!;
      const d4 = d[o + 4 * step]!, d5 = d[o + 5 * step]!, d6 = d[o + 6 * step]!, d7 = d[o + 7 * step]!;
      const t0 = d0 + d7, t7 = d0 - d7, t1 = d1 + d6, t6 = d1 - d6;
      const t2 = d2 + d5, t5 = d2 - d5, t3 = d3 + d4, t4 = d3 - d4;
      // Bagian genap.
      const t10 = t0 + t3, t13 = t0 - t3, t11 = t1 + t2, t12 = t1 - t2;
      d[o] = t10 + t11;
      d[o + 4 * step] = t10 - t11;
      const z1 = (t12 + t13) * 0.707106781;
      d[o + 2 * step] = t13 + z1;
      d[o + 6 * step] = t13 - z1;
      // Bagian ganjil.
      const u10 = t4 + t5, u11 = t5 + t6, u12 = t6 + t7;
      const z5 = (u10 - u12) * 0.382683433;
      const z2 = 0.5411961 * u10 + z5;
      const z4 = 1.306562965 * u12 + z5;
      const z3 = u11 * 0.707106781;
      const z11 = t7 + z3, z13 = t7 - z3;
      d[o + 5 * step] = z13 + z2;
      d[o + 3 * step] = z13 - z2;
      d[o + step] = z11 + z4;
      d[o + 7 * step] = z11 - z4;
    }
  }
}

class BlockCoder {
  private readonly block = new Float32Array(64);
  private readonly zz = new Int16Array(64);

  constructor(private readonly bits: BitWriter) {}

  /** Satu blok 8x8 dari `plane` (lebar `stride`) di (x, y); mengembalikan DC terkuantisasi. */
  encode(plane: Float32Array, stride: number, x: number, y: number, div: Float32Array, prevDc: number, dc: Huffman, ac: Huffman): number {
    const b = this.block;
    for (let r = 0; r < 8; r += 1) {
      const row = (y + r) * stride + x;
      for (let c = 0; c < 8; c += 1) b[r * 8 + c] = plane[row + c]!;
    }
    fdct(b);
    const zz = this.zz;
    for (let i = 0; i < 64; i += 1) {
      const n = ZIGZAG[i]!;
      const v = Math.round(b[n]! * div[n]!);
      // Batas baseline 8-bit: DC 11 bit, AC 10 bit (jaga-jaga pembulatan float).
      zz[i] = i === 0 ? Math.max(-2047, Math.min(2047, v)) : Math.max(-1023, Math.min(1023, v));
    }
    const bits = this.bits;
    const diff = zz[0]! - prevDc;
    const dcCat = category(diff);
    bits.put(dc.code[dcCat]!, dc.size[dcCat]!);
    if (dcCat) bits.put(diff < 0 ? diff - 1 : diff, dcCat);

    let last = 63;
    while (last > 0 && zz[last] === 0) last -= 1;
    let run = 0;
    for (let i = 1; i <= last; i += 1) {
      const v = zz[i]!;
      if (v === 0) {
        run += 1;
        continue;
      }
      while (run > 15) {
        bits.put(ac.code[0xf0]!, ac.size[0xf0]!);
        run -= 16;
      }
      const cat = category(v);
      const sym = (run << 4) | cat;
      bits.put(ac.code[sym]!, ac.size[sym]!);
      bits.put(v < 0 ? v - 1 : v, cat);
      run = 0;
    }
    if (last < 63) bits.put(ac.code[0]!, ac.size[0]!);
    return zz[0]!;
  }
}

function dht(out: Output, cls: number, id: number, bits: readonly number[], values: readonly number[]): void {
  out.segment(0xc4, [[(cls << 4) | id], bits, values]);
}

/** Sampel 8-bit seperti `quantize(rgb, 8)` (NaN -> 0). */
function sample8(v: number): number {
  return v > 0 ? (v >= 1 ? 255 : Math.round(v * 255)) : 0;
}

/**
 * Encode RGB float (0..1, interleaved, encoding colour space keluaran sudah
 * diterapkan) menjadi JPEG baseline.
 */
export function encodeJpeg(rgb: Float32Array, width: number, height: number, options: JpegOptions): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 65535 || height > 65535) {
    throw new RangeError(`dimensi JPEG tidak sah: ${width}x${height}`);
  }
  if (rgb.length !== width * height * 3) {
    throw new RangeError(`butuh ${width * height * 3} nilai RGB untuk ${width}x${height}, diterima ${rgb.length}`);
  }
  const quality = Math.min(100, Math.max(1, Math.round(options.quality)));
  const full = quality >= FULL_CHROMA_QUALITY;
  const qtLuma = quantTable(STD_LUMA, quality);
  const qtChroma = quantTable(STD_CHROMA, quality);
  const divLuma = divisors(qtLuma);
  const divChroma = divisors(qtChroma);

  // Perkiraan awal: ~1,5 byte/piksel pada q100 4:4:4, jauh lebih kecil di bawahnya.
  const out = new Output(Math.ceil(width * height * (full ? 1.5 : 0.5)) + 4096 + (options.icc?.length ?? 0));
  out.u8(0xff);
  out.u8(0xd8);
  const exif = options.exif && options.exif.length <= JPEG_MAX_EXIF_BYTES ? options.exif : undefined;
  if (exif) {
    out.segment(0xe1, ['Exif\0\0', exif]);
  } else {
    // JFIF 1.02, rasio aspek 1:1 tanpa satuan, tanpa thumbnail.
    out.segment(0xe0, ['JFIF\0', [1, 2, 0, 0, 1, 0, 1, 0, 0]]);
  }
  if (options.icc && options.icc.length > 0) {
    const icc = options.icc;
    const chunks = Math.ceil(icc.length / ICC_CHUNK_BYTES);
    if (chunks <= 255) {
      for (let i = 0; i < chunks; i += 1) {
        out.segment(0xe2, ['ICC_PROFILE\0', [i + 1, chunks], icc.subarray(i * ICC_CHUNK_BYTES, (i + 1) * ICC_CHUNK_BYTES)]);
      }
    }
  }
  const zigzagged = (qt: Uint8Array) => Array.from(ZIGZAG, (n) => qt[n]!);
  out.segment(0xdb, [[0], zigzagged(qtLuma), [1], zigzagged(qtChroma)]);
  out.segment(0xc0, [[8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, 1, full ? 0x11 : 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]]);
  dht(out, 0, 0, DC_LUMA_BITS, DC_VALUES);
  dht(out, 1, 0, AC_LUMA_BITS, AC_LUMA_VALUES);
  dht(out, 0, 1, DC_CHROMA_BITS, DC_VALUES);
  dht(out, 1, 1, AC_CHROMA_BITS, AC_CHROMA_VALUES);
  out.segment(0xda, [[3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0]]);

  // Strip satu baris MCU, tepi kanan/bawah direplikasi (seperti libjpeg).
  const mcu = full ? 8 : 16;
  const mcusX = Math.ceil(width / mcu);
  const stripW = mcusX * mcu;
  const Y = new Float32Array(stripW * mcu);
  const Cb = new Float32Array(stripW * mcu);
  const Cr = new Float32Array(stripW * mcu);
  const cw = stripW / (full ? 1 : 2);
  const ch = mcu / (full ? 1 : 2);
  const Cbs = full ? Cb : new Float32Array(cw * ch);
  const Crs = full ? Cr : new Float32Array(cw * ch);

  const bits = new BitWriter(out);
  const coder = new BlockCoder(bits);
  let dcY = 0;
  let dcCb = 0;
  let dcCr = 0;
  // Batas atas keluaran satu baris MCU: tiap blok paling banyak ~ (16+11) + 63 x (16+10) bit, x2 untuk stuffing.
  const blocksPerRow = mcusX * (full ? 3 : 6);
  const rowBudget = blocksPerRow * 64 * 27 * 2 / 8 + 64;

  for (let y0 = 0; y0 < height; y0 += mcu) {
    for (let r = 0; r < mcu; r += 1) {
      const sy = Math.min(height - 1, y0 + r);
      const src = sy * width * 3;
      const dst = r * stripW;
      for (let x = 0; x < stripW; x += 1) {
        const s = src + Math.min(width - 1, x) * 3;
        const R = sample8(rgb[s]!);
        const G = sample8(rgb[s + 1]!);
        const B = sample8(rgb[s + 2]!);
        Y[dst + x] = 0.299 * R + 0.587 * G + 0.114 * B - 128;
        Cb[dst + x] = -0.168735892 * R - 0.331264108 * G + 0.5 * B;
        Cr[dst + x] = 0.5 * R - 0.418687589 * G - 0.081312411 * B;
      }
    }
    if (!full) {
      for (let r = 0; r < ch; r += 1) {
        for (let c = 0; c < cw; c += 1) {
          const a = 2 * r * stripW + 2 * c;
          const b = a + stripW;
          Cbs[r * cw + c] = (Cb[a]! + Cb[a + 1]! + Cb[b]! + Cb[b + 1]!) * 0.25;
          Crs[r * cw + c] = (Cr[a]! + Cr[a + 1]! + Cr[b]! + Cr[b + 1]!) * 0.25;
        }
      }
    }
    out.ensure(rowBudget);
    for (let m = 0; m < mcusX; m += 1) {
      const x = m * mcu;
      if (full) {
        dcY = coder.encode(Y, stripW, x, 0, divLuma, dcY, HUFF.dcLuma, HUFF.acLuma);
      } else {
        dcY = coder.encode(Y, stripW, x, 0, divLuma, dcY, HUFF.dcLuma, HUFF.acLuma);
        dcY = coder.encode(Y, stripW, x + 8, 0, divLuma, dcY, HUFF.dcLuma, HUFF.acLuma);
        dcY = coder.encode(Y, stripW, x, 8, divLuma, dcY, HUFF.dcLuma, HUFF.acLuma);
        dcY = coder.encode(Y, stripW, x + 8, 8, divLuma, dcY, HUFF.dcLuma, HUFF.acLuma);
      }
      const cx = full ? x : x / 2;
      dcCb = coder.encode(Cbs, cw, cx, 0, divChroma, dcCb, HUFF.dcChroma, HUFF.acChroma);
      dcCr = coder.encode(Crs, cw, cx, 0, divChroma, dcCr, HUFF.dcChroma, HUFF.acChroma);
    }
  }
  out.ensure(16);
  bits.flush();
  out.u8(0xff);
  out.u8(0xd9);
  return out.buf.slice(0, out.length);
}
