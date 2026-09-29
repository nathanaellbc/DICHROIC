/**
 * EXIF untuk ekspor: diambil dari berkas asli lalu ditulis ulang dengan
 * bersih, supaya foto hasil DICHROIC tetap membawa kamera, lensa, eksposur,
 * tanggal, dan lokasi (GPS) -- yang dipakai Photos untuk mengurutkan dan
 * memetakan.
 *
 * Sumber (struktur TIFF EXIF):
 *   JPEG     APP1 `Exif\0\0`
 *   PNG      chunk `eXIf`
 *   TIFF/DNG/CR2/NEF/ARW  berkas itu sendiri (IFD0 + ExifIFD)
 *   HEIF/HEIC/AVIF  item `Exif` di kotak `meta` (iinf + iloc)
 *
 * Penulisan ulang (bukan salin mentah), byte order sumber dipertahankan:
 *   IFD0     hanya tag deskriptif (Make, Model, tanggal, pemilik, resolusi),
 *            Orientation = 1 (piksel ekspor sudah tegak), Software = DICHROIC;
 *   ExifIFD  semua tag kecuali MakerNote (blob vendor dengan offset absolut
 *            yang rusak bila dipindah), pointer Interop, dan koordinat subjek
 *            (merujuk piksel sebelum rotasi/crop); PixelX/YDimension diganti
 *            ukuran ekspor, ColorSpace 1 (sRGB) atau 0xFFFF (lainnya, profil
 *            ICC yang menentukan -- cara Apple menandai Display P3);
 *   GPS IFD  apa adanya;
 *   IFD1     (thumbnail) dibuang: thumbnail asli tidak menampilkan hasil edit.
 */

export interface ExifRewrite {
  width: number;
  height: number;
  /** true bila colour space keluaran sRGB. */
  srgb: boolean;
  software?: string;
  /** Batas ukuran hasil (APP1 JPEG: 65527). */
  maxBytes?: number;
}

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_INTEROP_IFD = 0xa005;
const TAG_ORIENTATION = 0x0112;
const TAG_SOFTWARE = 0x0131;
const TAG_YCBCR_POSITIONING = 0x0213;
const TAG_MAKER_NOTE = 0x927c;
const TAG_COLOR_SPACE = 0xa001;
const TAG_PIXEL_X = 0xa002;
const TAG_PIXEL_Y = 0xa003;
const TAG_SUBJECT_AREA = 0x9214;
const TAG_SUBJECT_LOCATION = 0xa214;

/** Tag IFD0 yang dibawa (selain yang ditulis sendiri). */
const IFD0_KEEP = new Set([
  0x010e, // ImageDescription
  0x010f, // Make
  0x0110, // Model
  0x011a, // XResolution
  0x011b, // YResolution
  0x0128, // ResolutionUnit
  0x0132, // DateTime
  0x013b, // Artist
  0x8298, // Copyright
]);

const EXIF_DROP = new Set([TAG_MAKER_NOTE, TAG_INTEROP_IFD, TAG_SUBJECT_AREA, TAG_SUBJECT_LOCATION, TAG_COLOR_SPACE, TAG_PIXEL_X, TAG_PIXEL_Y]);

/** Ukuran satu nilai per tipe TIFF (1..13); 0 = tipe tak dikenal. */
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

/** Nilai tunggal lebih besar dari ini dibuang (UserComment raksasa, blob vendor). */
const MAX_VALUE_BYTES = 8192;

function ascii(bytes: Uint8Array, start: number, length: number): string {
  let s = '';
  for (let i = start; i < start + length && i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]!);
  return s;
}

function isTiff(b: Uint8Array): boolean {
  return b.length >= 8 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42));
}

// ---------------------------------------------------------------------------
// Ekstraksi

function fromJpeg(bytes: Uint8Array): Uint8Array | undefined {
  let o = 2;
  while (o + 4 <= bytes.length && bytes[o] === 0xff) {
    const marker = bytes[o + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) {
      o += marker === 0xff ? 1 : 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const length = (bytes[o + 2]! << 8) | bytes[o + 3]!;
    if (marker === 0xe1 && ascii(bytes, o + 4, 6) === 'Exif\0\0') {
      const tiff = bytes.subarray(o + 10, Math.min(bytes.length, o + 2 + length));
      return isTiff(tiff) ? tiff : undefined;
    }
    o += 2 + length;
  }
  return undefined;
}

function fromPng(bytes: Uint8Array): Uint8Array | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 8;
  while (o + 8 <= bytes.length) {
    const length = view.getUint32(o);
    const type = ascii(bytes, o + 4, 4);
    if (type === 'eXIf') {
      const body = bytes.subarray(o + 8, Math.min(bytes.length, o + 8 + length));
      return isTiff(body) ? body : undefined;
    }
    if (type === 'IEND') break;
    o += 12 + length;
  }
  return undefined;
}

interface Box {
  type: string;
  /** Awal isi (setelah header). */
  start: number;
  end: number;
}

function boxes(bytes: Uint8Array, view: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let o = start;
  while (o + 8 <= end) {
    let size = view.getUint32(o);
    const type = ascii(bytes, o + 4, 4);
    let header = 8;
    if (size === 1) {
      if (o + 16 > end) break;
      size = Number(view.getBigUint64(o + 8));
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) break;
    out.push({ type, start: o + header, end: o + size });
    o += size;
  }
  return out;
}

/** Item `Exif` HEIF (ISO/IEC 23008-12 A.2.1): u32 offset header TIFF, lalu data. */
function fromHeif(bytes: Uint8Array): Uint8Array | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const meta = boxes(bytes, view, 0, bytes.length).find((b) => b.type === 'meta');
  if (!meta) return undefined;
  const children = boxes(bytes, view, meta.start + 4, meta.end); // FullBox
  const iinf = children.find((b) => b.type === 'iinf');
  const iloc = children.find((b) => b.type === 'iloc');
  if (!iinf || !iloc) return undefined;

  let exifId: number | undefined;
  const iinfVersion = bytes[iinf.start]!;
  const infeStart = iinf.start + 4 + (iinfVersion === 0 ? 2 : 4);
  for (const infe of boxes(bytes, view, infeStart, iinf.end)) {
    if (infe.type !== 'infe') continue;
    const version = bytes[infe.start]!;
    if (version < 2) continue;
    const idSize = version === 2 ? 2 : 4;
    const id = idSize === 2 ? view.getUint16(infe.start + 4) : view.getUint32(infe.start + 4);
    if (ascii(bytes, infe.start + 4 + idSize + 2, 4) === 'Exif') {
      exifId = id;
      break;
    }
  }
  if (exifId === undefined) return undefined;

  const version = bytes[iloc.start]!;
  let o = iloc.start + 4;
  const sizes1 = bytes[o]!;
  const sizes2 = bytes[o + 1]!;
  o += 2;
  const offsetSize = sizes1 >> 4;
  const lengthSize = sizes1 & 15;
  const baseSize = sizes2 >> 4;
  const indexSize = version === 1 || version === 2 ? sizes2 & 15 : 0;
  const readN = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i += 1) v = v * 256 + bytes[o + i]!;
    o += n;
    return v;
  };
  const count = readN(version < 2 ? 2 : 4);
  for (let i = 0; i < count; i += 1) {
    const id = readN(version < 2 ? 2 : 4);
    const method = version === 1 || version === 2 ? readN(2) & 15 : 0;
    readN(2); // data_reference_index
    const base = readN(baseSize);
    const extents = readN(2);
    const parts: Array<[number, number]> = [];
    for (let e = 0; e < extents; e += 1) {
      if (indexSize) readN(indexSize);
      parts.push([base + readN(offsetSize), readN(lengthSize)]);
    }
    if (id !== exifId) continue;
    let origin = 0;
    if (method === 1) {
      const idat = children.find((b) => b.type === 'idat');
      if (!idat) return undefined;
      origin = idat.start;
    } else if (method !== 0) {
      return undefined;
    }
    const total = parts.reduce((n, [, len]) => n + len, 0);
    const data = new Uint8Array(total);
    let at = 0;
    for (const [off, len] of parts) {
      if (origin + off + len > bytes.length) return undefined;
      data.set(bytes.subarray(origin + off, origin + off + len), at);
      at += len;
    }
    if (data.length < 4) return undefined;
    const tiff = data.subarray(4 + new DataView(data.buffer).getUint32(0));
    return isTiff(tiff) ? tiff : undefined;
  }
  return undefined;
}

function isHeif(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp';
}

/** Struktur TIFF EXIF dari berkas asli, atau `undefined` bila tidak ada. */
export function extractExif(bytes: Uint8Array): Uint8Array | undefined {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return fromJpeg(bytes);
    if (bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG') return fromPng(bytes);
    if (isTiff(bytes)) return bytes;
    if (isHeif(bytes)) return fromHeif(bytes);
  } catch {
    // EXIF rusak tidak boleh menggagalkan pembukaan/ekspor.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Penulisan ulang

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Byte nilai, sudah dalam byte order keluaran. */
  value: Uint8Array;
}

class Reader {
  readonly view: DataView;
  readonly le: boolean;

  constructor(readonly tiff: Uint8Array) {
    this.view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    this.le = tiff[0] === 0x49;
  }

  u16(o: number): number {
    return this.view.getUint16(o, this.le);
  }

  u32(o: number): number {
    return this.view.getUint32(o, this.le);
  }

  /** Entri satu IFD, dengan nilai tersalin; entri rusak dilewati. */
  ifd(offset: number): Entry[] {
    const t = this.tiff;
    if (offset < 8 || offset + 2 > t.length) return [];
    const n = this.u16(offset);
    const out: Entry[] = [];
    for (let i = 0; i < n; i += 1) {
      const e = offset + 2 + i * 12;
      if (e + 12 > t.length) break;
      const tag = this.u16(e);
      const type = this.u16(e + 2);
      const count = this.u32(e + 4);
      const unit = TYPE_SIZE[type] ?? 0;
      if (!unit || count === 0) continue;
      const bytes = unit * count;
      if (bytes > MAX_VALUE_BYTES) continue;
      const at = bytes <= 4 ? e + 8 : this.u32(e + 8);
      if (at + bytes > t.length) continue;
      out.push({ tag, type, count, value: t.slice(at, at + bytes) });
    }
    return out;
  }

  pointer(entries: Entry[], tag: number): number | undefined {
    const e = entries.find((x) => x.tag === tag && (x.type === 4 || x.type === 13) && x.count === 1);
    return e ? new DataView(e.value.buffer).getUint32(0, this.le) : undefined;
  }
}

function short(v: number, le: boolean): Entry['value'] {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, le);
  return b;
}

function long(v: number, le: boolean): Entry['value'] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, le);
  return b;
}

function asciiValue(s: string): Uint8Array {
  return Uint8Array.from([...Array.from(s, (c) => c.charCodeAt(0) & 0x7f), 0]);
}

function ifdSize(entries: Entry[]): number {
  let n = 2 + entries.length * 12 + 4;
  for (const e of entries) if (e.value.length > 4) n += e.value.length + (e.value.length & 1);
  return n;
}

/** Tipe yang elemennya ditukar per 2/4/8 byte saat byte order berganti. */
function swapUnit(type: number): number {
  if (type === 3 || type === 8) return 2;
  if (type === 4 || type === 9 || type === 11 || type === 13 || type === 5 || type === 10) return 4; // rasional: dua LONG
  if (type === 12) return 8;
  return 1;
}

function reorder(e: Entry): Entry {
  const unit = swapUnit(e.type);
  if (unit === 1) return e;
  const value = new Uint8Array(e.value.length);
  for (let i = 0; i < value.length; i += unit) for (let k = 0; k < unit; k += 1) value[i + k] = e.value[i + unit - 1 - k]!;
  return { ...e, value };
}

interface Layout {
  le: boolean;
  /** IFD0 tanpa pointer ExifIFD/GPS. */
  ifd0: Entry[];
  exif: Entry[];
  gps: Entry[];
}

/** Tag yang dibawa, dijepit ke `maxBytes` (lihat kepala modul). */
function layout(source: Uint8Array, options: ExifRewrite & { le?: boolean }): Layout | undefined {
  if (!isTiff(source)) return undefined;
  const r = new Reader(source);
  const le = options.le ?? r.le;
  const src0 = r.ifd(r.u32(4));
  const exifAt = r.pointer(src0, TAG_EXIF_IFD);
  const gpsAt = r.pointer(src0, TAG_GPS_IFD);
  const conv = (list: Entry[]) => (le === r.le ? list : list.map(reorder));

  const ifd0: Entry[] = conv(src0.filter((e) => IFD0_KEEP.has(e.tag)));
  ifd0.push({ tag: TAG_ORIENTATION, type: 3, count: 1, value: short(1, le) });
  const software = asciiValue(options.software ?? 'DICHROIC');
  ifd0.push({ tag: TAG_SOFTWARE, type: 2, count: software.length, value: software });
  // Wajib untuk JPEG (EXIF 2.32 §4.6.5); 1 = centered, nilai libjpeg/iPhone.
  ifd0.push({ tag: TAG_YCBCR_POSITIONING, type: 3, count: 1, value: short(1, le) });

  const exif: Entry[] = conv((exifAt !== undefined ? r.ifd(exifAt) : []).filter((e) => !EXIF_DROP.has(e.tag)));
  exif.push({ tag: TAG_COLOR_SPACE, type: 3, count: 1, value: short(options.srgb ? 1 : 0xffff, le) });
  exif.push({ tag: TAG_PIXEL_X, type: 4, count: 1, value: long(options.width, le) });
  exif.push({ tag: TAG_PIXEL_Y, type: 4, count: 1, value: long(options.height, le) });
  let gps: Entry[] = gpsAt !== undefined ? conv(r.ifd(gpsAt)) : [];

  // Batas ukuran: buang nilai terbesar di ExifIFD dulu, lalu GPS.
  const max = options.maxBytes ?? Infinity;
  const total = () => 8 + ifdSize(ifd0) + 12 * (gps.length ? 2 : 1) + ifdSize(exif) + (gps.length ? ifdSize(gps) : 0);
  while (total() > max) {
    const biggest = exif.reduce<Entry | undefined>((b, e) => (e.value.length > 4 && e.value.length > (b?.value.length ?? 4) ? e : b), undefined);
    if (biggest) exif.splice(exif.indexOf(biggest), 1);
    else if (gps.length) gps = [];
    else return undefined;
  }
  for (const list of [ifd0, exif, gps]) list.sort((a, b) => a.tag - b.tag);
  return { le, ifd0, exif, gps };
}

/** Tulis satu IFD di `at` (offset berkas = `base + at`); pointer tag -> offset berkas. */
function writeIfd(out: Uint8Array, le: boolean, base: number, entries: Entry[], at: number, pointers: ReadonlyMap<number, number> = new Map()): void {
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint16(at, entries.length, le);
  let data = at + 2 + entries.length * 12 + 4;
  entries.forEach((e, i) => {
    const p = at + 2 + i * 12;
    view.setUint16(p, e.tag, le);
    view.setUint16(p + 2, e.type, le);
    view.setUint32(p + 4, e.count, le);
    const pointer = pointers.get(e.tag);
    if (pointer !== undefined) {
      view.setUint32(p + 8, pointer, le);
    } else if (e.value.length <= 4) {
      out.set(e.value, p + 8);
    } else {
      view.setUint32(p + 8, base + data, le);
      out.set(e.value, data);
      data += e.value.length + (e.value.length & 1);
    }
  });
  view.setUint32(at + 2 + entries.length * 12, 0, le); // tanpa IFD berikutnya (IFD1 dibuang)
}

/**
 * EXIF bersih untuk berkas ekspor (lihat kepala modul), atau `undefined` bila
 * sumber tidak sah. Hasil adalah struktur TIFF (tanpa `Exif\0\0`).
 */
export function rewriteExif(source: Uint8Array, options: ExifRewrite): Uint8Array | undefined {
  const l = layout(source, options);
  if (!l) return undefined;
  const { le, exif, gps } = l;
  const ifd0 = [...l.ifd0, { tag: TAG_EXIF_IFD, type: 4, count: 1, value: long(0, le) }];
  if (gps.length) ifd0.push({ tag: TAG_GPS_IFD, type: 4, count: 1, value: long(0, le) });
  ifd0.sort((a, b) => a.tag - b.tag);

  const atExif = 8 + ifdSize(ifd0);
  const atGps = atExif + ifdSize(exif);
  const out = new Uint8Array(atGps + (gps.length ? ifdSize(gps) : 0));
  const view = new DataView(out.buffer);
  out[0] = out[1] = le ? 0x49 : 0x4d;
  view.setUint16(2, 42, le);
  view.setUint32(4, 8, le);
  const pointers = new Map([[TAG_EXIF_IFD, atExif]]);
  if (gps.length) pointers.set(TAG_GPS_IFD, atGps);
  writeIfd(out, le, 0, ifd0, 8, pointers);
  writeIfd(out, le, 0, exif, atExif);
  if (gps.length) writeIfd(out, le, 0, gps, atGps);
  return out;
}

/** Entri IFD0 mentah untuk penulis TIFF (byte order little-endian). */
export interface RawTiffEntry {
  tag: number;
  type: number;
  count: number;
  value: Uint8Array;
}

/**
 * EXIF untuk berkas TIFF ekspor (little-endian): tag IFD0 deskriptif untuk
 * digabung ke IFD0 gambar, dan ExifIFD/GPS sebagai blok yang ditaruh penulis
 * TIFF di offset berkas `base` (`place`). Pointer 34665/34853 ikut di `ifd0`
 * dan menunjuk ke dalam blok itu.
 */
export function exifForTiff(
  source: Uint8Array,
  options: ExifRewrite,
): { ifd0: RawTiffEntry[]; blockBytes: number; place(base: number): { ifd0: RawTiffEntry[]; block: Uint8Array } } | undefined {
  const l = layout(source, { ...options, le: true });
  if (!l) return undefined;
  const { gps } = l;
  // Tag ExifIFD khusus JPEG (EXIF 2.32 tabel 7): TIFF menyatakannya di IFD0.
  const exif = l.exif.filter((e) => e.tag !== 0x9101 && e.tag !== TAG_PIXEL_X && e.tag !== TAG_PIXEL_Y);
  // Tag struktur gambar ditulis penulis TIFF sendiri.
  const own = new Set([TAG_ORIENTATION, TAG_SOFTWARE, TAG_YCBCR_POSITIONING, 0x011a, 0x011b, 0x0128]);
  const descriptive = l.ifd0.filter((e) => !own.has(e.tag));
  const blockBytes = ifdSize(exif) + (gps.length ? ifdSize(gps) : 0);
  const pointerEntries = (base: number): RawTiffEntry[] => [
    { tag: TAG_EXIF_IFD, type: 4, count: 1, value: long(base, true) },
    ...(gps.length ? [{ tag: TAG_GPS_IFD, type: 4, count: 1, value: long(base + ifdSize(exif), true) }] : []),
  ];
  return {
    ifd0: [...descriptive, ...pointerEntries(0)],
    blockBytes,
    place(base: number) {
      if (base & 1) throw new RangeError('offset IFD harus genap');
      const block = new Uint8Array(blockBytes);
      writeIfd(block, true, base, exif, 0);
      if (gps.length) writeIfd(block, true, base, gps, ifdSize(exif));
      return { ifd0: [...descriptive, ...pointerEntries(base)], block };
    },
  };
}
