/**
 * Profil ICC v4 (matrix/TRC, kelas monitor) untuk colour space keluaran,
 * disematkan ke JPEG/PNG/TIFF ekspor supaya Photos, Safari, dan editor lain
 * menampilkan warnanya persis -- terutama Display P3 dari iPhone, yang tanpa
 * profil akan dibaca sebagai sRGB (lebih pucat).
 *
 * Profil dibangun dari definisi yang SAMA dengan yang dipakai
 * `scannerPost.wgsl` untuk meng-encode (`manifest.outputColorSpaces`):
 * matriks RGB->XYZ (putih Y = 1), titik putih, dan jenis encoding. Kolorant
 * diadaptasi ke PCS D50 dengan Bradford (tag `chad` mencatat matriksnya),
 * kurva TRC parametrik (`para`) mencerminkan `outputEncode` shader:
 *
 *   srgb  -> tipe 3: Y = ((X + 0.055)/1.055)^2.4, X/12.92 di bawah 0.04045
 *   romm  -> tipe 3: Y = X^1.8, X/16 di bawah 1/32 (ProPhoto, 16v di bawah 1/512)
 *   gamma -> tipe 0: Y = X^g
 *   linear-> tipe 0: g = 1
 *
 * Deterministik (tanggal tetap, tanpa MD5) supaya ekspor dapat diuji byte.
 */
import type { OutputColorSpaceSpec } from '../profiles/types';

/** Putih PCS ICC (D50), nilai persis spesifikasi. */
const PCS_D50: readonly [number, number, number] = [0.9642, 1.0, 0.8249];

const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];

type Mat3 = number[][];

function mul(a: Mat3, b: Mat3): Mat3 {
  return a.map((row) => b[0]!.map((_, j) => row.reduce((s, v, k) => s + v * b[k]![j]!, 0)));
}

function mulVec(a: Mat3, v: readonly number[]): number[] {
  return a.map((row) => row.reduce((s, x, k) => s + x * v[k]!, 0));
}

function inverse(m: Mat3): Mat3 {
  const [a, b, c] = m[0]!;
  const [d, e, f] = m[1]!;
  const [g, h, i] = m[2]!;
  const A = e! * i! - f! * h!;
  const B = -(d! * i! - f! * g!);
  const C = d! * h! - e! * g!;
  const det = a! * A + b! * B + c! * C;
  return [
    [A / det, -(b! * i! - c! * h!) / det, (b! * f! - c! * e!) / det],
    [B / det, (a! * i! - c! * g!) / det, -(a! * f! - c! * d!) / det],
    [C / det, -(a! * h! - b! * g!) / det, (a! * e! - b! * d!) / det],
  ];
}

/** Matriks adaptasi Bradford dari putih `src` ke putih `dst` (XYZ). */
export function bradford(src: readonly number[], dst: readonly number[]): Mat3 {
  const s = mulVec(BRADFORD, src);
  const d = mulVec(BRADFORD, dst);
  const scale: Mat3 = [
    [d[0]! / s[0]!, 0, 0],
    [0, d[1]! / s[1]!, 0],
    [0, 0, d[2]! / s[2]!],
  ];
  return mul(mul(inverse(BRADFORD), scale), BRADFORD);
}

interface Trc {
  type: 0 | 3;
  params: number[];
}

function trcFor(spec: OutputColorSpaceSpec): Trc {
  switch (spec.encoding) {
    case 'srgb':
      return { type: 3, params: [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045] };
    case 'romm':
      return { type: 3, params: [1.8, 1, 0, 1 / 16, 1 / 32] };
    case 'gamma':
      return { type: 0, params: [spec.gamma ?? 1] };
    case 'linear':
      return { type: 0, params: [1] };
  }
}

/** Penulis byte big-endian sederhana. */
class Writer {
  private buf = new Uint8Array(1024);
  length = 0;

  private grow(n: number): void {
    if (this.length + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + n));
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  u8(v: number): void {
    this.grow(1);
    this.buf[this.length++] = v & 0xff;
  }

  u16(v: number): void {
    this.u8(v >>> 8);
    this.u8(v);
  }

  u32(v: number): void {
    this.u16(v >>> 16);
    this.u16(v & 0xffff);
  }

  s15f16(v: number): void {
    this.u32(Math.round(v * 65536) | 0);
  }

  ascii(s: string): void {
    for (let i = 0; i < s.length; i += 1) this.u8(s.charCodeAt(i));
  }

  align4(): void {
    while (this.length % 4) this.u8(0);
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

function mluc(text: string): Uint8Array {
  const w = new Writer();
  w.ascii('mluc');
  w.u32(0);
  w.u32(1); // satu rekaman
  w.u32(12); // ukuran rekaman
  w.ascii('enUS');
  w.u32(text.length * 2);
  w.u32(28); // offset string dari awal tag
  for (let i = 0; i < text.length; i += 1) w.u16(text.charCodeAt(i));
  return w.bytes();
}

function xyz(v: readonly number[]): Uint8Array {
  const w = new Writer();
  w.ascii('XYZ ');
  w.u32(0);
  for (const x of v) w.s15f16(x);
  return w.bytes();
}

function sf32(m: Mat3): Uint8Array {
  const w = new Writer();
  w.ascii('sf32');
  w.u32(0);
  for (const row of m) for (const x of row) w.s15f16(x);
  return w.bytes();
}

function para(trc: Trc): Uint8Array {
  const w = new Writer();
  w.ascii('para');
  w.u32(0);
  w.u16(trc.type);
  w.u16(0);
  for (const p of trc.params) w.s15f16(p);
  return w.bytes();
}

/**
 * Profil ICC v4 untuk satu colour space keluaran. `description` menjadi tag
 * `desc` (yang dibaca `iccDescription` dan dipetakan balik ke label).
 */
export function buildIccProfile(spec: OutputColorSpaceSpec, description: string): Uint8Array {
  const m = spec.rgbToXyz;
  const rgbToXyz: Mat3 = [m.slice(0, 3), m.slice(3, 6), m.slice(6, 9)];
  // Putih dari matriks sendiri (baris dijumlah): persis putih yang dituju shader.
  const white = rgbToXyz.map((row) => row[0]! + row[1]! + row[2]!);
  const chad = bradford(white, PCS_D50);
  const adapted = mul(chad, rgbToXyz);
  const column = (j: number) => [adapted[0]![j]!, adapted[1]![j]!, adapted[2]![j]!];

  const trc = para(trcFor(spec));
  const tags: Array<[string, Uint8Array]> = [
    ['desc', mluc(description)],
    ['cprt', mluc('No copyright, use freely')],
    ['wtpt', xyz(PCS_D50)],
    ['chad', sf32(chad)],
    ['rXYZ', xyz(column(0))],
    ['gXYZ', xyz(column(1))],
    ['bXYZ', xyz(column(2))],
    ['rTRC', trc],
    ['gTRC', trc],
    ['bTRC', trc],
  ];

  // Tata letak: header 128, tabel tag, lalu data (TRC yang sama dibagi).
  const tableSize = 4 + tags.length * 12;
  let cursor = 128 + tableSize;
  const placed = new Map<Uint8Array, number>();
  const entries = tags.map(([sig, data]) => {
    let offset = placed.get(data);
    if (offset === undefined) {
      offset = cursor;
      placed.set(data, offset);
      cursor += data.length;
      cursor += (4 - (cursor % 4)) % 4;
    }
    return { sig, offset, size: data.length };
  });
  const total = cursor;

  const w = new Writer();
  w.u32(total);
  w.u32(0); // CMM
  w.u32(0x04300000); // versi 4.3
  w.ascii('mntr');
  w.ascii('RGB ');
  w.ascii('XYZ ');
  for (const v of [2026, 1, 1, 0, 0, 0]) w.u16(v); // tanggal tetap (deterministik)
  w.ascii('acsp');
  w.u32(0); // platform
  w.u32(0); // flags
  w.u32(0); // manufacturer
  w.u32(0); // model
  w.u32(0);
  w.u32(0); // attributes
  w.u32(0); // rendering intent: perceptual
  for (const v of PCS_D50) w.s15f16(v);
  w.ascii('dchr'); // creator
  for (let i = 0; i < 16; i += 1) w.u8(0); // profile ID (opsional)
  for (let i = 0; i < 28; i += 1) w.u8(0);

  w.u32(tags.length);
  for (const e of entries) {
    w.ascii(e.sig);
    w.u32(e.offset);
    w.u32(e.size);
  }
  const written = new Set<number>();
  for (const [, data] of tags) {
    const offset = placed.get(data)!;
    if (written.has(offset)) continue;
    written.add(offset);
    w.align4();
    for (const b of data) w.u8(b);
  }
  w.align4();
  return w.bytes();
}

/** Pembaca kecil untuk test: kolorant dan TRC profil hasil `buildIccProfile`. */
export function parseIccForTest(icc: Uint8Array): {
  colorants: Record<'r' | 'g' | 'b', number[]>;
  trc: Record<string, number>;
} {
  const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
  const s15 = (o: number) => view.getInt32(o) / 65536;
  const find = (sig: string) => {
    const n = view.getUint32(128);
    for (let i = 0; i < n; i += 1) {
      const e = 132 + i * 12;
      if (String.fromCharCode(...icc.subarray(e, e + 4)) === sig) return view.getUint32(e + 4);
    }
    throw new Error(`tag ${sig} tidak ada`);
  };
  const col = (sig: string) => [0, 1, 2].map((k) => s15(find(sig) + 8 + 4 * k));
  const t = find('rTRC');
  const type = view.getUint16(t + 8);
  const names = type === 3 ? ['g', 'a', 'b', 'c', 'd'] : ['g'];
  const trc: Record<string, number> = { type };
  names.forEach((n, k) => (trc[n] = s15(t + 12 + 4 * k)));
  return { colorants: { r: col('rXYZ'), g: col('gXYZ'), b: col('bXYZ') }, trc };
}
