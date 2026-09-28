/**
 * Deteksi format gambar dari magic bytes, bukan ekstensi (spec Fase 2 §5).
 *
 * TIFF perlu satu langkah lebih: banyak RAW kamera (DNG, CR2, NEF, ARW, PEF,
 * 3FR, ...) adalah berkas TIFF. Yang dipakai sebagai penanda RAW:
 *
 * - tag `DNGVersion` (50706) di IFD0;
 * - CR2: `II*\0` diikuti `CR` di offset 8;
 * - IFD mana pun (rantai IFD0 atau SubIFD tingkat pertama) dengan
 *   `PhotometricInterpretation` CFA (32803) atau LinearRaw (34892), atau
 *   kompresi khusus vendor RAW.
 *
 * Rencana 2B menyebut tag `Make` kamera untuk NEF/ARW. Itu sengaja TIDAK
 * dipakai sendirian: TIFF biasa yang ditulis kamera atau scanner juga membawa
 * `Make`, dan salah membacanya sebagai RAW berarti gambar RGB yang sah ditolak
 * LibRaw. NEF dan ARW sama-sama menyimpan mosaik di SubIFD ber-photometric
 * CFA, jadi aturan CFA sudah menangkapnya tanpa risiko itu.
 *
 * RAW non-TIFF (ORF, RW2, RAF, CR3, CRW, X3F, MRW) dikenali dari magic-nya.
 * Selebihnya `'unknown'`; `decodeImage` tetap mencoba LibRaw untuk itu karena
 * LibRaw mengenali lebih banyak format daripada daftar ini.
 */

export type ImageFormat = 'jpeg' | 'png' | 'tiff' | 'exr' | 'raw';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const TAG_COMPRESSION = 259;
const TAG_PHOTOMETRIC = 262;
const TAG_SUB_IFDS = 330;
const TAG_DNG_VERSION = 50706;

const PHOTOMETRIC_CFA = 32803;
const PHOTOMETRIC_LINEAR_RAW = 34892;

/**
 * Kompresi TIFF yang hanya dipakai RAW vendor (daftar LibRaw/ExifTool):
 * 32767 Sony ARW, 32769 Nikon/Epson packed, 32770 Samsung SRW, 34316
 * Panasonic, 34713 Nikon NEF, 65000 Kodak DCR, 65535 Pentax PEF. PackBits
 * (32773) sengaja tidak masuk: TIFF biasa memakainya.
 */
const RAW_COMPRESSIONS = new Set([32767, 32769, 32770, 34316, 34713, 65000, 65535]);

/** Batas penelusuran IFD: berkas rusak bisa punya rantai melingkar. */
const MAX_IFDS = 32;

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  for (let i = 0; i < magic.length; i += 1) if (bytes[offset + i] !== magic[i]) return false;
  return true;
}

function ascii(text: string): number[] {
  return Array.from(text, (c) => c.charCodeAt(0));
}

/** Pembaca TIFF minimal: cukup untuk memeriksa tag, bukan untuk mendecode. */
class TiffProbe {
  readonly #view: DataView;
  readonly #le: boolean;

  constructor(bytes: Uint8Array, littleEndian: boolean) {
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#le = littleEndian;
  }

  #u16(at: number): number | undefined {
    return at >= 0 && at + 2 <= this.#view.byteLength ? this.#view.getUint16(at, this.#le) : undefined;
  }

  #u32(at: number): number | undefined {
    return at >= 0 && at + 4 <= this.#view.byteLength ? this.#view.getUint32(at, this.#le) : undefined;
  }

  get firstIfd(): number | undefined {
    return this.#u32(4);
  }

  /** Entri IFD sebagai `tag -> nilai pertama` plus offset IFD berikutnya. */
  readIfd(offset: number): { tags: Map<number, number[]>; next: number } | undefined {
    const count = this.#u16(offset);
    if (count === undefined || count === 0) return undefined;
    const tags = new Map<number, number[]>();
    for (let i = 0; i < count; i += 1) {
      const entry = offset + 2 + i * 12;
      const tag = this.#u16(entry);
      const type = this.#u16(entry + 2);
      const n = this.#u32(entry + 4);
      if (tag === undefined || type === undefined || n === undefined) return undefined;
      tags.set(tag, this.#values(entry + 8, type, n));
    }
    return { tags, next: this.#u32(offset + 2 + count * 12) ?? 0 };
  }

  /** Nilai SHORT/LONG/IFD; tipe lain cukup ditandai hadir (array kosong). */
  #values(field: number, type: number, n: number): number[] {
    const size = type === 3 ? 2 : type === 4 || type === 13 ? 4 : 0;
    if (size === 0) return [];
    const count = Math.min(n, 64);
    const at = size * n <= 4 ? field : this.#u32(field);
    if (at === undefined) return [];
    const out: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const v = size === 2 ? this.#u16(at + i * 2) : this.#u32(at + i * 4);
      if (v === undefined) break;
      out.push(v);
    }
    return out;
  }
}

function isRawIfd(tags: Map<number, number[]>): boolean {
  const photometric = tags.get(TAG_PHOTOMETRIC)?.[0];
  if (photometric === PHOTOMETRIC_CFA || photometric === PHOTOMETRIC_LINEAR_RAW) return true;
  const compression = tags.get(TAG_COMPRESSION)?.[0];
  return compression !== undefined && RAW_COMPRESSIONS.has(compression);
}

function tiffIsRaw(bytes: Uint8Array, littleEndian: boolean): boolean {
  // CR2: header TIFF biasa, lalu "CR" + versi di offset 8.
  if (littleEndian && startsWith(bytes, ascii('CR'), 8)) return true;

  const probe = new TiffProbe(bytes, littleEndian);
  const visited = new Set<number>();
  const queue: number[] = [];
  let offset = probe.firstIfd ?? 0;
  let first = true;
  while (offset > 0 && !visited.has(offset) && visited.size < MAX_IFDS) {
    visited.add(offset);
    const ifd = probe.readIfd(offset);
    if (!ifd) break;
    if (first && ifd.tags.has(TAG_DNG_VERSION)) return true;
    first = false;
    if (isRawIfd(ifd.tags)) return true;
    queue.push(...(ifd.tags.get(TAG_SUB_IFDS) ?? []));
    offset = ifd.next;
  }
  for (const sub of queue) {
    if (visited.has(sub) || visited.size >= MAX_IFDS) continue;
    visited.add(sub);
    const ifd = probe.readIfd(sub);
    if (ifd && isRawIfd(ifd.tags)) return true;
  }
  return false;
}

export function detectFormat(bytes: Uint8Array): ImageFormat | 'unknown' {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(bytes, PNG_MAGIC)) return 'png';
  if (startsWith(bytes, [0x76, 0x2f, 0x31, 0x01])) return 'exr';

  // RAW non-TIFF. ORF dan RW2 memakai header mirip TIFF dengan magic lain.
  if (
    startsWith(bytes, ascii('IIRO')) || startsWith(bytes, ascii('IIRS')) || startsWith(bytes, ascii('MMOR')) ||
    startsWith(bytes, [0x49, 0x49, 0x55, 0x00]) ||
    startsWith(bytes, ascii('FUJIFILMCCD-RAW')) ||
    startsWith(bytes, ascii('ftypcrx '), 4) ||
    startsWith(bytes, ascii('HEAPCCDR'), 6) ||
    startsWith(bytes, ascii('FOVb')) ||
    startsWith(bytes, [0x00, 0x4d, 0x52, 0x4d])
  ) {
    return 'raw';
  }

  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00])) return tiffIsRaw(bytes, true) ? 'raw' : 'tiff';
  if (startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return tiffIsRaw(bytes, false) ? 'raw' : 'tiff';
  return 'unknown';
}
