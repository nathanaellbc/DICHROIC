/**
 * Decoder JPEG 8-bit (baseline, extended-Huffman, progresif) yang meniru
 * keluaran bawaan libjpeg-turbo -- pustaka di balik Pillow dan semua browser
 * utama -- sampai ke bit:
 *
 * - IDCT integer "islow" (`jidctint.c`, Loeffler-Ligtenberg-Moschytz,
 *   CONST_BITS 13, PASS1_BITS 2) beserta tabel range-limit-nya;
 * - upsampling chroma "fancy" (`jdsample.c`: h2v1, h1v2, h2v2 segitiga) dengan
 *   replikasi baris/kolom tepi seperti `jdmainct.c`;
 * - konversi YCbCr -> RGB titik tetap 16-bit (`jdcolor.c`).
 *
 * Kenapa bukan `jpeg-js`: pustaka itu memakai IDCT poppler, konversi warna
 * float, dan upsampling chroma nearest-neighbour. Terukur terhadap Pillow
 * pada fixture 4:2:0: selisih maksimum 125/255 di tepi warna jenuh -- bukan
 * derau pembulatan, tapi gambar yang berbeda dari yang dilihat pengguna di
 * browser. Ambang tidak dilonggarkan; decodernya yang diganti.
 *
 * Tidak didukung (melempar `Error`, dibungkus `DecodeError` oleh
 * `decodeImage`): presisi 12/16-bit, lossless (SOF3), pengodean aritmetika
 * (SOF9+), hierarkis, dan JPEG 4 komponen (CMYK/YCCK). Berkas yang berakhir
 * sebelum EOI dianggap terpotong dan ditolak -- libjpeg mengisi sisanya
 * dengan abu-abu dan hanya memberi peringatan.
 */

/** Batas piksel: header rusak tidak boleh memicu alokasi raksasa. */
export const JPEG_MAX_PIXELS = 250_000_000;

// Urutan zig-zag -> indeks natural (baris-mayor 8x8).
const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

export interface JpegPixels {
  width: number;
  height: number;
  /** 1 (grayscale) atau 3 (RGB), 8-bit ter-interleave. */
  channels: 1 | 3;
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// Huffman

interface HuffmanTable {
  /** Lookup 9 bit: `(panjang << 8) | nilai`, 0 bila kode lebih panjang. */
  fast: Uint16Array;
  maxcode: Int32Array; // indeks 1..16; -1 bila tidak ada kode sepanjang itu
  valptr: Int32Array;
  mincode: Int32Array;
  values: Uint8Array;
}

const FAST_BITS = 9;

function buildHuffman(counts: Uint8Array, values: Uint8Array): HuffmanTable {
  const fast = new Uint16Array(1 << FAST_BITS);
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len += 1) {
    const n = counts[len - 1]!;
    if (n > 0) {
      valptr[len] = k;
      mincode[len] = code;
      for (let i = 0; i < n; i += 1) {
        if (len <= FAST_BITS) {
          const shift = FAST_BITS - len;
          const base = code << shift;
          for (let j = 0; j < 1 << shift; j += 1) fast[base + j] = (len << 8) | values[k]!;
        }
        code += 1;
        k += 1;
      }
      maxcode[len] = code - 1;
    }
    if (code > 1 << len) throw new Error('tabel Huffman tidak sah');
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff; // penjaga: kode tak sah terdeteksi di decode()
  return { fast, maxcode, valptr, mincode, values };
}

// ---------------------------------------------------------------------------
// Pembaca bit segmen entropi

class BitReader {
  #data: Uint8Array;
  pos: number;
  #acc = 0;
  #bits = 0;
  /** Bit nol yang disisipkan setelah marker/akhir berkas (belum boleh dipakai). */
  #padding = 0;

  constructor(data: Uint8Array, pos: number) {
    this.#data = data;
    this.pos = pos;
  }

  #fill(): void {
    while (this.#bits <= 24) {
      let byte = 0;
      if (this.#padding === 0 && this.pos < this.#data.length) {
        byte = this.#data[this.pos]!;
        if (byte === 0xff) {
          const next = this.#data[this.pos + 1];
          if (next === 0x00) {
            this.pos += 2;
          } else {
            byte = 0;
            this.#padding += 8; // marker: berhenti di sini
          }
        } else {
          this.pos += 1;
        }
      } else {
        this.#padding += 8;
      }
      this.#acc = ((this.#acc << 8) | byte) >>> 0;
      this.#bits += 8;
    }
  }

  #consume(n: number): void {
    this.#bits -= n;
    if (this.#bits < this.#padding) throw new Error('data entropi terpotong atau rusak');
  }

  bits(n: number): number {
    if (n === 0) return 0;
    if (this.#bits < n) this.#fill();
    const v = (this.#acc >>> (this.#bits - n)) & ((1 << n) - 1);
    this.#consume(n);
    return v;
  }

  bit(): number {
    return this.bits(1);
  }

  /** `receive` + `extend` (spec F.2.2.1). */
  signed(n: number): number {
    if (n === 0) return 0;
    const v = this.bits(n);
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  }

  decode(table: HuffmanTable): number {
    if (this.#bits < 16) this.#fill();
    const look = (this.#acc >>> (this.#bits - FAST_BITS)) & ((1 << FAST_BITS) - 1);
    const hit = table.fast[look]!;
    if (hit !== 0) {
      this.#consume(hit >> 8);
      return hit & 0xff;
    }
    let len = FAST_BITS + 1;
    let code = (this.#acc >>> (this.#bits - len)) & ((1 << len) - 1);
    while (len <= 16 && code > table.maxcode[len]!) {
      len += 1;
      code = (this.#acc >>> (this.#bits - len)) & ((1 << len) - 1);
    }
    if (len > 16) throw new Error('kode Huffman tidak sah');
    this.#consume(len);
    return table.values[table.valptr[len]! + code - table.mincode[len]!]!;
  }

  /** Buang sisa bit dan lanjutkan dari byte berikutnya (restart/akhir scan). */
  reset(): void {
    this.#acc = 0;
    this.#bits = 0;
    this.#padding = 0;
  }
}

// ---------------------------------------------------------------------------
// Frame

interface Component {
  id: number;
  h: number;
  v: number;
  tq: number;
  /** Dimensi komponen sebenarnya (downsampled_width/height libjpeg). */
  width: number;
  height: number;
  /** Blok yang berisi data (non-interleaved) dan blok teralokasi (MCU penuh). */
  blocksPerLine: number;
  blocksPerColumn: number;
  allocPerLine: number;
  allocPerColumn: number;
  coeffs: Int16Array;
  dcTable?: HuffmanTable;
  acTable?: HuffmanTable;
  pred: number;
}

interface Frame {
  progressive: boolean;
  width: number;
  height: number;
  maxH: number;
  maxV: number;
  mcusPerLine: number;
  mcusPerColumn: number;
  components: Component[];
}

function u16(data: Uint8Array, at: number): number {
  if (at + 2 > data.length) throw new Error('berkas terpotong');
  return (data[at]! << 8) | data[at + 1]!;
}

function readFrame(data: Uint8Array, at: number, len: number, progressive: boolean): Frame {
  const precision = data[at]!;
  if (precision !== 8) throw new Error(`presisi sampel ${precision}-bit belum didukung`);
  const height = u16(data, at + 1);
  const width = u16(data, at + 3);
  const count = data[at + 5]!;
  if (height === 0) throw new Error('tinggi 0 (marker DNL) belum didukung');
  if (width === 0) throw new Error('lebar 0 tidak sah');
  if (width * height > JPEG_MAX_PIXELS) {
    throw new Error(`${width}x${height} melebihi batas ${JPEG_MAX_PIXELS / 1e6} MP`);
  }
  if (count !== 1 && count !== 3) throw new Error(`JPEG ${count} komponen (CMYK/YCCK?) belum didukung`);
  if (len < 6 + count * 3) throw new Error('segmen SOF terpotong');
  const raw: Array<{ id: number; h: number; v: number; tq: number }> = [];
  for (let i = 0; i < count; i += 1) {
    const p = at + 6 + i * 3;
    const hv = data[p + 1]!;
    const h = hv >> 4;
    const v = hv & 15;
    if (h < 1 || h > 4 || v < 1 || v > 4) throw new Error('faktor sampling tidak sah');
    raw.push({ id: data[p]!, h, v, tq: data[p + 2]! & 3 });
  }
  const maxH = Math.max(...raw.map((c) => c.h));
  const maxV = Math.max(...raw.map((c) => c.v));
  const mcusPerLine = Math.ceil(width / (8 * maxH));
  const mcusPerColumn = Math.ceil(height / (8 * maxV));
  const components = raw.map((c): Component => {
    const cw = Math.ceil((width * c.h) / maxH);
    const ch = Math.ceil((height * c.v) / maxV);
    const allocPerLine = mcusPerLine * c.h;
    const allocPerColumn = mcusPerColumn * c.v;
    return {
      ...c,
      width: cw,
      height: ch,
      blocksPerLine: Math.ceil(cw / 8),
      blocksPerColumn: Math.ceil(ch / 8),
      allocPerLine,
      allocPerColumn,
      coeffs: new Int16Array(allocPerLine * allocPerColumn * 64),
      pred: 0,
    };
  });
  return { progressive, width, height, maxH, maxV, mcusPerLine, mcusPerColumn, components };
}

// ---------------------------------------------------------------------------
// Scan

interface Scan {
  components: Component[];
  ss: number;
  se: number;
  ah: number;
  al: number;
}

type BlockDecoder = (reader: BitReader, c: Component, offset: number) => void;

function decodeScan(data: Uint8Array, start: number, frame: Frame, scan: Scan, restartInterval: number): number {
  const reader = new BitReader(data, start);
  const { ss, se, ah, al } = scan;
  let eobrun = 0;

  const baseline: BlockDecoder = (r, c, o) => {
    const t = r.decode(c.dcTable!);
    c.pred += r.signed(t);
    c.coeffs[o] = c.pred;
    for (let k = 1; k < 64; ) {
      const rs = r.decode(c.acTable!);
      const s = rs & 15;
      const run = rs >> 4;
      if (s === 0) {
        if (run < 15) break;
        k += 16;
        continue;
      }
      k += run;
      if (k > 63) throw new Error('koefisien AC di luar blok');
      c.coeffs[o + ZIGZAG[k]!] = r.signed(s);
      k += 1;
    }
  };
  const dcFirst: BlockDecoder = (r, c, o) => {
    const t = r.decode(c.dcTable!);
    c.pred += r.signed(t);
    c.coeffs[o] = c.pred * (1 << al);
  };
  const dcRefine: BlockDecoder = (r, c, o) => {
    if (r.bit()) c.coeffs[o] = c.coeffs[o]! | (1 << al);
  };
  const acFirst: BlockDecoder = (r, c, o) => {
    if (eobrun > 0) {
      eobrun -= 1;
      return;
    }
    for (let k = ss; k <= se; ) {
      const rs = r.decode(c.acTable!);
      const s = rs & 15;
      const run = rs >> 4;
      if (s === 0) {
        if (run < 15) {
          eobrun = (1 << run) - 1 + r.bits(run);
          break;
        }
        k += 16;
        continue;
      }
      k += run;
      if (k > 63) throw new Error('koefisien AC di luar blok');
      c.coeffs[o + ZIGZAG[k]!] = r.signed(s) * (1 << al);
      k += 1;
    }
  };
  // Port langsung `decode_mcu_AC_refine` (jdphuff.c).
  const acRefine: BlockDecoder = (r, c, o) => {
    const p1 = 1 << al;
    const m1 = -1 << al;
    const coeffs = c.coeffs;
    let k = ss;
    if (eobrun === 0) {
      for (; k <= se; k += 1) {
        const rs = r.decode(c.acTable!);
        let run = rs >> 4;
        let s = rs & 15;
        if (s !== 0) {
          if (s !== 1) throw new Error('refinement AC dengan ukuran != 1');
          s = r.bit() ? p1 : m1;
        } else if (run !== 15) {
          eobrun = (1 << run) + r.bits(run);
          break;
        }
        do {
          const z = o + ZIGZAG[k]!;
          if (coeffs[z] !== 0) {
            if (r.bit() && (coeffs[z]! & p1) === 0) coeffs[z] = coeffs[z]! + (coeffs[z]! >= 0 ? p1 : m1);
          } else {
            run -= 1;
            if (run < 0) break;
          }
          k += 1;
        } while (k <= se);
        if (s !== 0) {
          if (k > 63) throw new Error('koefisien AC di luar blok');
          coeffs[o + ZIGZAG[k]!] = s;
        }
      }
    }
    if (eobrun > 0) {
      for (; k <= se; k += 1) {
        const z = o + ZIGZAG[k]!;
        if (coeffs[z] !== 0 && r.bit() && (coeffs[z]! & p1) === 0) {
          coeffs[z] = coeffs[z]! + (coeffs[z]! >= 0 ? p1 : m1);
        }
      }
      eobrun -= 1;
    }
  };

  let decode: BlockDecoder;
  if (!frame.progressive) decode = baseline;
  else if (ss === 0) decode = ah === 0 ? dcFirst : dcRefine;
  else decode = ah === 0 ? acFirst : acRefine;

  const single = scan.components.length === 1;
  const only = scan.components[0]!;
  const mcus = single ? only.blocksPerLine * only.blocksPerColumn : frame.mcusPerLine * frame.mcusPerColumn;
  const perRestart = restartInterval > 0 ? restartInterval : mcus;

  for (let mcu = 0; mcu < mcus; mcu += 1) {
    if (mcu > 0 && mcu % perRestart === 0) {
      reader.reset();
      const marker = u16(data, reader.pos);
      if (marker < 0xffd0 || marker > 0xffd7) throw new Error('marker restart hilang');
      reader.pos += 2;
      for (const c of scan.components) c.pred = 0;
      eobrun = 0;
    }
    if (single) {
      const row = Math.floor(mcu / only.blocksPerLine);
      const col = mcu % only.blocksPerLine;
      decode(reader, only, (row * only.allocPerLine + col) * 64);
    } else {
      const mcuRow = Math.floor(mcu / frame.mcusPerLine);
      const mcuCol = mcu % frame.mcusPerLine;
      for (const c of scan.components) {
        for (let v = 0; v < c.v; v += 1) {
          for (let h = 0; h < c.h; h += 1) {
            const row = mcuRow * c.v + v;
            const col = mcuCol * c.h + h;
            decode(reader, c, (row * c.allocPerLine + col) * 64);
          }
        }
      }
    }
  }
  reader.reset();
  return reader.pos;
}

// ---------------------------------------------------------------------------
// IDCT islow (jidctint.c)

const CONST_BITS = 13;
const PASS1_BITS = 2;
const FIX_0_298631336 = 2446;
const FIX_0_390180644 = 3196;
const FIX_0_541196100 = 4433;
const FIX_0_765366865 = 6270;
const FIX_0_899976223 = 7373;
const FIX_1_175875602 = 9633;
const FIX_1_501321110 = 12299;
const FIX_1_847759065 = 15137;
const FIX_1_961570560 = 16069;
const FIX_2_053119869 = 16819;
const FIX_2_562915447 = 20995;
const FIX_3_072711026 = 25172;

/**
 * `prepare_range_limit_table` (jdmaster.c), dilihat dari `IDCT_range_limit`:
 * indeks `v & 1023` untuk keluaran IDCT bertanda `v` (sebelum + 128).
 */
const IDCT_LIMIT = (() => {
  const t = new Uint8Array(1024);
  for (let x = 0; x < 1024; x += 1) {
    const v = x < 512 ? x : x - 1024; // tafsiran bertanda
    t[x] = Math.min(255, Math.max(0, v + 128));
  }
  // Wilayah "wrap" libjpeg: 384..639 -> 255, 640..895 -> 0. Nilai bertanda di
  // atas sudah memberi itu untuk 384..511 (255) dan 512..895 (0).
  return t;
})();

const descale = (x: number, n: number): number => (x + (1 << (n - 1))) >> n;

function idctBlock(coeffs: Int16Array, at: number, q: Int32Array, out: Uint8Array, outAt: number, stride: number, ws: Int32Array): void {
  // Tahap 1: kolom.
  for (let col = 0; col < 8; col += 1) {
    const i = at + col;
    if (
      coeffs[i + 8] === 0 && coeffs[i + 16] === 0 && coeffs[i + 24] === 0 && coeffs[i + 32] === 0 &&
      coeffs[i + 40] === 0 && coeffs[i + 48] === 0 && coeffs[i + 56] === 0
    ) {
      const dc = (coeffs[i]! * q[col]!) << PASS1_BITS;
      for (let r = 0; r < 8; r += 1) ws[r * 8 + col] = dc;
      continue;
    }
    let z2 = coeffs[i + 16]! * q[col + 16]!;
    let z3 = coeffs[i + 48]! * q[col + 48]!;
    let z1 = (z2 + z3) * FIX_0_541196100;
    let tmp2 = z1 + z3 * -FIX_1_847759065;
    let tmp3 = z1 + z2 * FIX_0_765366865;
    z2 = coeffs[i]! * q[col]!;
    z3 = coeffs[i + 32]! * q[col + 32]!;
    let tmp0 = (z2 + z3) << CONST_BITS;
    let tmp1 = (z2 - z3) << CONST_BITS;
    const tmp10 = tmp0 + tmp3;
    const tmp13 = tmp0 - tmp3;
    const tmp11 = tmp1 + tmp2;
    const tmp12 = tmp1 - tmp2;

    tmp0 = coeffs[i + 56]! * q[col + 56]!;
    tmp1 = coeffs[i + 40]! * q[col + 40]!;
    tmp2 = coeffs[i + 24]! * q[col + 24]!;
    tmp3 = coeffs[i + 8]! * q[col + 8]!;
    z1 = tmp0 + tmp3;
    z2 = tmp1 + tmp2;
    z3 = tmp0 + tmp2;
    let z4 = tmp1 + tmp3;
    const z5 = (z3 + z4) * FIX_1_175875602;
    tmp0 *= FIX_0_298631336;
    tmp1 *= FIX_2_053119869;
    tmp2 *= FIX_3_072711026;
    tmp3 *= FIX_1_501321110;
    z1 *= -FIX_0_899976223;
    z2 *= -FIX_2_562915447;
    z3 = z3 * -FIX_1_961570560 + z5;
    z4 = z4 * -FIX_0_390180644 + z5;
    tmp0 += z1 + z3;
    tmp1 += z2 + z4;
    tmp2 += z2 + z3;
    tmp3 += z1 + z4;

    const n = CONST_BITS - PASS1_BITS;
    ws[col] = descale(tmp10 + tmp3, n);
    ws[56 + col] = descale(tmp10 - tmp3, n);
    ws[8 + col] = descale(tmp11 + tmp2, n);
    ws[48 + col] = descale(tmp11 - tmp2, n);
    ws[16 + col] = descale(tmp12 + tmp1, n);
    ws[40 + col] = descale(tmp12 - tmp1, n);
    ws[24 + col] = descale(tmp13 + tmp0, n);
    ws[32 + col] = descale(tmp13 - tmp0, n);
  }

  // Tahap 2: baris.
  const n = CONST_BITS + PASS1_BITS + 3;
  for (let row = 0; row < 8; row += 1) {
    const w = row * 8;
    const o = outAt + row * stride;
    if (ws[w + 1] === 0 && ws[w + 2] === 0 && ws[w + 3] === 0 && ws[w + 4] === 0 &&
      ws[w + 5] === 0 && ws[w + 6] === 0 && ws[w + 7] === 0) {
      const dc = IDCT_LIMIT[descale(ws[w]!, PASS1_BITS + 3) & 1023]!;
      for (let k = 0; k < 8; k += 1) out[o + k] = dc;
      continue;
    }
    let z2 = ws[w + 2]!;
    let z3 = ws[w + 6]!;
    let z1 = (z2 + z3) * FIX_0_541196100;
    let tmp2 = z1 + z3 * -FIX_1_847759065;
    let tmp3 = z1 + z2 * FIX_0_765366865;
    let tmp0 = (ws[w]! + ws[w + 4]!) << CONST_BITS;
    let tmp1 = (ws[w]! - ws[w + 4]!) << CONST_BITS;
    const tmp10 = tmp0 + tmp3;
    const tmp13 = tmp0 - tmp3;
    const tmp11 = tmp1 + tmp2;
    const tmp12 = tmp1 - tmp2;

    tmp0 = ws[w + 7]!;
    tmp1 = ws[w + 5]!;
    tmp2 = ws[w + 3]!;
    tmp3 = ws[w + 1]!;
    z1 = tmp0 + tmp3;
    z2 = tmp1 + tmp2;
    z3 = tmp0 + tmp2;
    let z4 = tmp1 + tmp3;
    const z5 = (z3 + z4) * FIX_1_175875602;
    tmp0 *= FIX_0_298631336;
    tmp1 *= FIX_2_053119869;
    tmp2 *= FIX_3_072711026;
    tmp3 *= FIX_1_501321110;
    z1 *= -FIX_0_899976223;
    z2 *= -FIX_2_562915447;
    z3 = z3 * -FIX_1_961570560 + z5;
    z4 = z4 * -FIX_0_390180644 + z5;
    tmp0 += z1 + z3;
    tmp1 += z2 + z4;
    tmp2 += z2 + z3;
    tmp3 += z1 + z4;

    out[o] = IDCT_LIMIT[descale(tmp10 + tmp3, n) & 1023]!;
    out[o + 7] = IDCT_LIMIT[descale(tmp10 - tmp3, n) & 1023]!;
    out[o + 1] = IDCT_LIMIT[descale(tmp11 + tmp2, n) & 1023]!;
    out[o + 6] = IDCT_LIMIT[descale(tmp11 - tmp2, n) & 1023]!;
    out[o + 2] = IDCT_LIMIT[descale(tmp12 + tmp1, n) & 1023]!;
    out[o + 5] = IDCT_LIMIT[descale(tmp12 - tmp1, n) & 1023]!;
    out[o + 3] = IDCT_LIMIT[descale(tmp13 + tmp0, n) & 1023]!;
    out[o + 4] = IDCT_LIMIT[descale(tmp13 - tmp0, n) & 1023]!;
  }
}

/** Bidang sampel komponen berukuran blok teralokasi (lebar `allocPerLine * 8`). */
function componentPlane(c: Component, q: Int32Array): { plane: Uint8Array; stride: number } {
  const stride = c.allocPerLine * 8;
  const plane = new Uint8Array(stride * c.allocPerColumn * 8);
  const ws = new Int32Array(64);
  for (let by = 0; by < c.blocksPerColumn; by += 1) {
    for (let bx = 0; bx < c.blocksPerLine; bx += 1) {
      idctBlock(c.coeffs, (by * c.allocPerLine + bx) * 64, q, plane, by * 8 * stride + bx * 8, stride, ws);
    }
  }
  return { plane, stride };
}

// ---------------------------------------------------------------------------
// Upsampling (jdsample.c) -> bidang penuh `width x height`

function upsample(frame: Frame, c: Component, src: Uint8Array, stride: number): Uint8Array {
  const { width, height, maxH, maxV } = frame;
  const out = new Uint8Array(width * height);
  const hx = maxH / c.h;
  const vx = maxV / c.v;
  const cw = c.width;
  const ch = c.height;
  const fancy = cw > 2;

  if (hx === 1 && vx === 1) {
    for (let y = 0; y < height; y += 1) out.set(src.subarray(y * stride, y * stride + width), y * width);
    return out;
  }

  // Satu baris keluaran h2 (fancy) dari "jumlah kolom" `sum[x]` (bobot total
  // `scale`, pembulatan +bias kiri/kanan persis h2v1/h2v2 libjpeg).
  const h2Row = (sum: (x: number) => number, o: number, shift: number, biasL: number, biasR: number) => {
    let last = sum(0);
    let cur = last;
    for (let x = 0; x < cw; x += 1) {
      const next = x + 1 < cw ? sum(x + 1) : cur;
      const left = x === 0 ? cur : last;
      const a = (cur * 3 + left + biasL) >> shift;
      const b = (cur * 3 + next + biasR) >> shift;
      if (2 * x < width) out[o + 2 * x] = a;
      if (2 * x + 1 < width) out[o + 2 * x + 1] = b;
      last = cur;
      cur = next;
    }
  };

  if (hx === 2 && vx === 1 && fancy) {
    for (let y = 0; y < height; y += 1) {
      const r = y * stride;
      h2Row((x) => src[r + x]!, y * width, 2, 1, 2);
    }
    return out;
  }
  // h1v2 libjpeg-turbo tidak mensyaratkan lebar > 2, beda dengan h2v1/h2v2.
  if (hx === 1 && vx === 2) {
    for (let y = 0; y < height; y += 1) {
      const row = y >> 1;
      const near = (y & 1) === 0 ? Math.max(row - 1, 0) : Math.min(row + 1, ch - 1);
      const bias = (y & 1) === 0 ? 1 : 2;
      for (let x = 0; x < width; x += 1) {
        out[y * width + x] = (src[row * stride + x]! * 3 + src[near * stride + x]! + bias) >> 2;
      }
    }
    return out;
  }
  if (hx === 2 && vx === 2 && fancy) {
    for (let y = 0; y < height; y += 1) {
      const row = y >> 1;
      const near = (y & 1) === 0 ? Math.max(row - 1, 0) : Math.min(row + 1, ch - 1);
      const r0 = row * stride;
      const r1 = near * stride;
      h2Row((x) => src[r0 + x]! * 3 + src[r1 + x]!, y * width, 4, 8, 7);
    }
    return out;
  }
  if (!Number.isInteger(hx) || !Number.isInteger(vx)) throw new Error('rasio sampling tidak bulat belum didukung');
  // int_upsample: replikasi.
  for (let y = 0; y < height; y += 1) {
    const r = Math.floor(y / vx) * stride;
    for (let x = 0; x < width; x += 1) out[y * width + x] = src[r + Math.floor(x / hx)]!;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Warna (jdcolor.c, SCALEBITS 16)

const YCC = (() => {
  const fix = (x: number) => Math.floor(x * 65536 + 0.5);
  const crR = new Int32Array(256);
  const cbB = new Int32Array(256);
  const crG = new Int32Array(256);
  const cbG = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    const x = i - 128;
    crR[i] = (fix(1.402) * x + 32768) >> 16;
    cbB[i] = (fix(1.772) * x + 32768) >> 16;
    crG[i] = -fix(0.71414) * x;
    cbG[i] = -fix(0.34414) * x + 32768;
  }
  return { crR, cbB, crG, cbG };
})();

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

// ---------------------------------------------------------------------------

interface Markers {
  jfif: boolean;
  adobeTransform: number | undefined;
}

function isRgbWithoutTransform(frame: Frame, markers: Markers): boolean {
  // default_decompress_parms (jdapimin.c).
  if (markers.jfif) return false;
  if (markers.adobeTransform !== undefined) return markers.adobeTransform === 0;
  const ids = frame.components.map((c) => c.id);
  return ids[0] === 0x52 && ids[1] === 0x47 && ids[2] === 0x42;
}

export function decodeJpegPixels(data: Uint8Array): JpegPixels {
  if (u16(data, 0) !== 0xffd8) throw new Error('bukan JPEG (SOI tidak ada)');
  const quant: Int32Array[] = [];
  const dcTables: HuffmanTable[] = [];
  const acTables: HuffmanTable[] = [];
  const markers: Markers = { jfif: false, adobeTransform: undefined };
  let frame: Frame | undefined;
  let restartInterval = 0;
  let scans = 0;
  let pos = 2;
  let ended = false;

  while (pos < data.length) {
    if (data[pos] !== 0xff) {
      pos += 1; // sampah di antara segmen: libjpeg juga melewatinya
      continue;
    }
    const marker = data[pos + 1];
    if (marker === undefined) break;
    if (marker === 0xff || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 1;
      continue;
    }
    if (marker === 0xd9) {
      ended = true;
      break;
    }
    const len = u16(data, pos + 2);
    const at = pos + 4;
    const end = pos + 2 + len;
    if (len < 2 || end > data.length) throw new Error('segmen terpotong');

    switch (marker) {
      case 0xc0:
      case 0xc1:
      case 0xc2:
        if (frame) throw new Error('lebih dari satu frame');
        frame = readFrame(data, at, len - 2, marker === 0xc2);
        break;
      case 0xc3: case 0xc5: case 0xc6: case 0xc7:
      case 0xc9: case 0xca: case 0xcb: case 0xcd: case 0xce: case 0xcf:
        throw new Error(`jenis frame SOF${marker - 0xc0} (lossless/aritmetika/hierarkis) belum didukung`);
      case 0xc4: {
        let p = at;
        while (p < end) {
          const tc = data[p]! >> 4;
          const th = data[p]! & 15;
          const counts = data.subarray(p + 1, p + 17);
          let total = 0;
          for (const n of counts) total += n;
          if (p + 17 + total > end || th > 3) throw new Error('segmen DHT tidak sah');
          const table = buildHuffman(counts, data.subarray(p + 17, p + 17 + total));
          (tc === 0 ? dcTables : acTables)[th] = table;
          p += 17 + total;
        }
        break;
      }
      case 0xdb: {
        let p = at;
        while (p < end) {
          const pq = data[p]! >> 4;
          const tq = data[p]! & 15;
          if (tq > 3 || pq > 1) throw new Error('segmen DQT tidak sah');
          const table = new Int32Array(64);
          for (let k = 0; k < 64; k += 1) {
            table[ZIGZAG[k]!] = pq === 0 ? data[p + 1 + k]! : u16(data, p + 1 + k * 2);
          }
          quant[tq] = table;
          p += 1 + 64 * (pq + 1);
        }
        break;
      }
      case 0xdd:
        restartInterval = u16(data, at);
        break;
      case 0xe0:
        if (len >= 7 && data[at] === 0x4a && data[at + 1] === 0x46 && data[at + 2] === 0x49 && data[at + 3] === 0x46 && data[at + 4] === 0) {
          markers.jfif = true;
        }
        break;
      case 0xee:
        if (len >= 14 && data[at] === 0x41 && data[at + 1] === 0x64 && data[at + 2] === 0x6f && data[at + 3] === 0x62 && data[at + 4] === 0x65) {
          markers.adobeTransform = data[at + 11];
        }
        break;
      case 0xda: {
        if (!frame) throw new Error('SOS sebelum SOF');
        const n = data[at]!;
        const comps: Component[] = [];
        for (let i = 0; i < n; i += 1) {
          const id = data[at + 1 + i * 2]!;
          const td = data[at + 2 + i * 2]!;
          const c = frame.components.find((x) => x.id === id);
          if (!c) throw new Error('scan merujuk komponen yang tidak ada');
          c.dcTable = dcTables[td >> 4];
          c.acTable = acTables[td & 15];
          c.pred = 0;
          comps.push(c);
        }
        const p = at + 1 + n * 2;
        const scan: Scan = { components: comps, ss: data[p]!, se: data[p + 1]!, ah: data[p + 2]! >> 4, al: data[p + 2]! & 15 };
        const needsDc = !frame.progressive || (scan.ss === 0 && scan.ah === 0);
        const needsAc = !frame.progressive || scan.ss > 0;
        for (const c of comps) {
          if ((needsDc && !c.dcTable) || (needsAc && !c.acTable)) throw new Error('tabel Huffman yang dirujuk scan tidak ada');
        }
        if (scan.se > 63 || scan.ss > scan.se) throw new Error('rentang spektral scan tidak sah');
        pos = decodeScan(data, end, frame, scan, restartInterval);
        scans += 1;
        continue;
      }
      default:
        break; // APPn/COM/lainnya: dilewati
    }
    pos = end;
  }

  if (!frame) throw new Error('tidak ada frame (SOF)');
  if (scans === 0) throw new Error('tidak ada data gambar (SOS)');
  if (!ended) throw new Error('berkas terpotong (EOI tidak ditemukan)');

  const f = frame;
  const planes = f.components.map((c) => {
    const q = quant[c.tq];
    if (!q) throw new Error('tabel kuantisasi yang dirujuk komponen tidak ada');
    const { plane, stride } = componentPlane(c, q);
    return upsample(f, c, plane, stride);
  });
  const n = f.width * f.height;
  if (planes.length === 1) return { width: f.width, height: f.height, channels: 1, data: planes[0]! };

  const out = new Uint8Array(n * 3);
  const [p0, p1, p2] = planes as [Uint8Array, Uint8Array, Uint8Array];
  if (isRgbWithoutTransform(f, markers)) {
    for (let i = 0; i < n; i += 1) {
      out[i * 3] = p0[i]!;
      out[i * 3 + 1] = p1[i]!;
      out[i * 3 + 2] = p2[i]!;
    }
  } else {
    const { crR, cbB, crG, cbG } = YCC;
    for (let i = 0; i < n; i += 1) {
      const y = p0[i]!;
      const cb = p1[i]!;
      const cr = p2[i]!;
      out[i * 3] = clamp8(y + crR[cr]!);
      out[i * 3 + 1] = clamp8(y + ((cbG[cb]! + crG[cr]!) >> 16));
      out[i * 3 + 2] = clamp8(y + cbB[cb]!);
    }
  }
  return { width: f.width, height: f.height, channels: 3, data: out };
}
