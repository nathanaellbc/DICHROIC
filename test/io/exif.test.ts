import { describe, it, expect } from 'vitest';
import { deflateSync } from 'fflate';
import { extractExif, rewriteExif } from '../../src/io/exif';
import { readMetadata } from '../../src/io/metadata';

/**
 * EXIF ekspor: ekstraksi dari tiap wadah dan penulisan ulang bersih. Sumber
 * dibangun di sini (byte order II dan MM) supaya setiap tag yang dibuang atau
 * dibawa diperiksa eksplisit. Oracle eksternal: `exiftool` membaca hasil
 * ekspor (dicek manual, lihat commit).
 */

type Value = { type: number; data: number[] | string };
type Ifd = Record<number, Value | { ifd: Ifd }>;

const SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

/** Penulis TIFF kecil: IFD0 + sub-IFD (pointer) + IFD1 opsional. */
function buildTiff(ifd0: Ifd, le: boolean, ifd1?: Ifd): Uint8Array {
  const buf = new Uint8Array(65536);
  const view = new DataView(buf.buffer);
  let end = 8;
  const alloc = (n: number) => {
    const at = end;
    end += n + (n & 1);
    return at;
  };
  const put = (type: number, data: number[] | string, at: number) => {
    if (typeof data === 'string') {
      for (let i = 0; i < data.length; i += 1) buf[at + i] = data.charCodeAt(i);
      return;
    }
    data.forEach((v, i) => {
      const o = at + i * SIZE[type]!;
      if (SIZE[type] === 1) buf[o] = v;
      else if (SIZE[type] === 2) view.setUint16(o, v, le);
      else view.setUint32(o, v, le);
    });
  };
  const write = (ifd: Ifd, next = 0): number => {
    const tags = Object.keys(ifd).map(Number).sort((a, b) => a - b);
    const at = alloc(2 + tags.length * 12 + 4);
    view.setUint16(at, tags.length, le);
    tags.forEach((tag, i) => {
      const e = at + 2 + i * 12;
      const v = ifd[tag]!;
      view.setUint16(e, tag, le);
      if ('ifd' in v) {
        view.setUint16(e + 2, 4, le);
        view.setUint32(e + 4, 1, le);
        view.setUint32(e + 8, write(v.ifd), le);
        return;
      }
      const count = typeof v.data === 'string' ? v.data.length : v.type === 5 ? v.data.length / 2 : v.data.length;
      const bytes = count * SIZE[v.type]!;
      view.setUint16(e + 2, v.type, le);
      view.setUint32(e + 4, count, le);
      if (bytes <= 4) put(v.type, v.data, e + 8);
      else {
        const d = alloc(bytes);
        put(v.type === 5 ? 4 : v.type, v.data, d);
        view.setUint32(e + 8, d, le);
      }
    });
    view.setUint32(at + 2 + tags.length * 12, next, le);
    return at;
  };
  buf[0] = buf[1] = le ? 0x49 : 0x4d;
  view.setUint16(2, 42, le);
  const first = write(ifd0);
  view.setUint32(4, first, le);
  if (ifd1) view.setUint32(first + 2 + Object.keys(ifd0).length * 12, write(ifd1), le);
  return buf.slice(0, end);
}

const str = (s: string): Value => ({ type: 2, data: `${s}\0` });

function camera(): Ifd {
  return {
    0x010f: str('Apple'),
    0x0110: str('iPhone 15 Pro'),
    0x0112: { type: 3, data: [6] }, // Orientation: putar 90
    0x0131: str('18.0'),
    0x0132: str('2026:09:01 10:11:12'),
    0x0100: { type: 4, data: [5712] }, // ImageWidth: tidak dibawa
    0x8769: {
      ifd: {
        0x829a: { type: 5, data: [1, 120] }, // ExposureTime
        0x829d: { type: 5, data: [178, 100] }, // FNumber
        0x8827: { type: 3, data: [64] }, // ISO
        0x9003: str('2026:09:01 10:11:12'),
        0x9214: { type: 3, data: [2000, 1500, 400, 300] }, // SubjectArea: dibuang
        0x927c: { type: 7, data: Array.from({ length: 600 }, (_, i) => i & 255) }, // MakerNote: dibuang
        0xa001: { type: 3, data: [0xffff] },
        0xa002: { type: 4, data: [5712] },
        0xa003: { type: 4, data: [4284] },
        0xa005: { ifd: { 0x0001: str('R98') } }, // Interop: dibuang
        0xa434: str('iPhone 15 Pro back triple camera 6.765mm f/1.78'),
      },
    },
    0x8825: {
      ifd: {
        0x0001: str('S'),
        0x0002: { type: 5, data: [6, 1, 12, 1, 3456, 100] },
        0x0003: str('E'),
        0x0004: { type: 5, data: [106, 1, 49, 1, 1234, 100] },
      },
    },
  };
}

/** Pembaca uji: tag -> {type, count, nilai numerik atau teks}. */
function parse(tiff: Uint8Array) {
  const le = tiff[0] === 0x49;
  const v = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const u16 = (o: number) => v.getUint16(o, le);
  const u32 = (o: number) => v.getUint32(o, le);
  const read = (at: number) => {
    const out = new Map<number, { type: number; count: number; nums: number[]; text: string; raw: Uint8Array }>();
    const n = u16(at);
    for (let i = 0; i < n; i += 1) {
      const e = at + 2 + i * 12;
      const type = u16(e + 2);
      const count = u32(e + 4);
      const size = SIZE[type]! * count;
      const d = size <= 4 ? e + 8 : u32(e + 8);
      const raw = tiff.subarray(d, d + size);
      const nums: number[] = [];
      const step = type === 5 ? 4 : SIZE[type]!;
      for (let k = 0; k < size / step; k += 1) nums.push(step === 1 ? raw[k]! : step === 2 ? u16(d + k * 2) : u32(d + k * 4));
      out.set(u16(e), { type, count, nums, text: String.fromCharCode(...raw).replace(/\0+$/, ''), raw });
    }
    return { entries: out, next: u32(at + 2 + n * 12) };
  };
  const ifd0 = read(u32(4));
  const exif = read(ifd0.entries.get(0x8769)!.nums[0]!);
  const gpsAt = ifd0.entries.get(0x8825)?.nums[0];
  return { le, ifd0, exif, gps: gpsAt === undefined ? undefined : read(gpsAt) };
}

describe('rewriteExif', () => {
  for (const le of [true, false]) {
    it(`membawa kamera/eksposur/GPS, membuang MakerNote/Interop/thumbnail (${le ? 'II' : 'MM'})`, () => {
      const src = buildTiff(camera(), le, { 0x0201: { type: 4, data: [0] }, 0x0202: { type: 4, data: [0] } });
      const out = rewriteExif(src, { width: 4284, height: 5712, srgb: false })!;
      const p = parse(out);
      expect(p.le).toBe(le);
      // IFD0
      expect(p.ifd0.entries.get(0x010f)!.text).toBe('Apple');
      expect(p.ifd0.entries.get(0x0110)!.text).toBe('iPhone 15 Pro');
      expect(p.ifd0.entries.get(0x0132)!.text).toBe('2026:09:01 10:11:12');
      expect(p.ifd0.entries.get(0x0112)!.nums).toEqual([1]);
      expect(p.ifd0.entries.get(0x0131)!.text).toBe('DICHROIC');
      expect(p.ifd0.entries.has(0x0100)).toBe(false);
      expect(p.ifd0.next).toBe(0); // IFD1 dibuang
      // ExifIFD
      expect(p.exif.entries.get(0x829a)!.nums).toEqual([1, 120]);
      expect(p.exif.entries.get(0x829d)!.nums).toEqual([178, 100]);
      expect(p.exif.entries.get(0x8827)!.nums).toEqual([64]);
      expect(p.exif.entries.get(0x9003)!.text).toBe('2026:09:01 10:11:12');
      expect(p.exif.entries.get(0xa434)!.text).toBe('iPhone 15 Pro back triple camera 6.765mm f/1.78');
      for (const gone of [0x927c, 0xa005, 0x9214]) expect(p.exif.entries.has(gone), gone.toString(16)).toBe(false);
      expect(p.exif.entries.get(0xa002)!.nums).toEqual([4284]);
      expect(p.exif.entries.get(0xa003)!.nums).toEqual([5712]);
      expect(p.exif.entries.get(0xa001)!.nums).toEqual([0xffff]);
      // GPS
      expect(p.gps!.entries.get(0x0001)!.text).toBe('S');
      expect(p.gps!.entries.get(0x0002)!.nums).toEqual([6, 1, 12, 1, 3456, 100]);
      expect(p.gps!.entries.get(0x0004)!.nums).toEqual([106, 1, 49, 1, 1234, 100]);
      // Tag terurut naik (syarat TIFF), ukuran genap per nilai.
      for (const ifd of [p.ifd0, p.exif, p.gps!]) {
        const tags = [...ifd.entries.keys()];
        expect(tags).toEqual([...tags].sort((a, b) => a - b));
      }
    });
  }

  it('sRGB: ColorSpace = 1', () => {
    const p = parse(rewriteExif(buildTiff(camera(), true), { width: 10, height: 10, srgb: true })!);
    expect(p.exif.entries.get(0xa001)!.nums).toEqual([1]);
  });

  it('tanpa ExifIFD/GPS di sumber: tetap menulis ExifIFD minimal', () => {
    const p = parse(rewriteExif(buildTiff({ 0x010f: str('Canon') }, true), { width: 3, height: 2, srgb: true })!);
    expect(p.ifd0.entries.get(0x010f)!.text).toBe('Canon');
    expect(p.exif.entries.get(0xa002)!.nums).toEqual([3]);
    expect(p.gps).toBeUndefined();
  });

  it('batas ukuran: nilai terbesar dibuang dulu, kamera tetap', () => {
    const ifd = camera();
    (ifd[0x8769] as { ifd: Ifd }).ifd[0x9286] = { type: 7, data: new Array(6000).fill(65) }; // UserComment
    const src = buildTiff(ifd, true);
    const full = rewriteExif(src, { width: 1, height: 1, srgb: true })!;
    const capped = rewriteExif(src, { width: 1, height: 1, srgb: true, maxBytes: full.length - 100 })!;
    expect(capped.length).toBeLessThanOrEqual(full.length - 100);
    const p = parse(capped);
    expect(p.exif.entries.has(0x9286)).toBe(false);
    expect(p.exif.entries.get(0x829a)!.nums).toEqual([1, 120]);
    expect(p.ifd0.entries.get(0x0110)!.text).toBe('iPhone 15 Pro');
  });

  it('sumber rusak: undefined, atau entri rusak dilewati tanpa melempar', () => {
    expect(rewriteExif(new Uint8Array([1, 2, 3]), { width: 1, height: 1, srgb: true })).toBeUndefined();
    const src = buildTiff(camera(), true);
    const view = new DataView(src.buffer);
    view.setUint32(view.getUint32(4, true) + 2 + 12 + 8, 0xfffffff0, true); // entri ke-2 (0x010F Make): offset nilai menunjuk ke luar berkas
    const p = parse(rewriteExif(src, { width: 1, height: 1, srgb: true })!);
    expect(p.ifd0.entries.has(0x010f)).toBe(false);
    expect(p.ifd0.entries.get(0x0110)!.text).toBe('iPhone 15 Pro');
  });
});

// ---------------------------------------------------------------------------

function jpegWith(tiff: Uint8Array): Uint8Array {
  const body = [...'Exif\0\0'].map((c) => c.charCodeAt(0)).concat(Array.from(tiff));
  const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 0, 0, 1, 0, 1, 0, 0];
  const len = body.length + 2;
  return Uint8Array.from([0xff, 0xd8, ...app0, 0xff, 0xe1, len >> 8, len & 255, ...body, 0xff, 0xda, 0, 2, 0xff, 0xd9]);
}

function pngWith(tiff: Uint8Array): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    return out; // CRC tidak diperiksa oleh ekstraksi
  };
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk('IHDR', new Uint8Array(13)), chunk('eXIf', tiff), chunk('IDAT', deflateSync(new Uint8Array(4))), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** HEIF minimal: ftyp, meta{hdlr, iinf{infe hvc1, infe Exif}, iloc}, mdat{Exif item}. */
function heifWith(tiff: Uint8Array, ilocVersion: 0 | 1, method: 0 | 1 = 0): Uint8Array {
  const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const u16 = (v: number) => [(v >>> 8) & 255, v & 255];
  const s = (t: string) => [...t].map((c) => c.charCodeAt(0));
  const box = (type: string, body: number[]) => [...u32(8 + body.length), ...s(type), ...body];
  const infe = (id: number, type: string) => box('infe', [2, 0, 0, 0, ...u16(id), 0, 0, ...s(type), 0]);
  const exifItem = [...u32(6), ...s('Exif\0\0'), ...Array.from(tiff)];
  const ftyp = box('ftyp', [...s('heic'), 0, 0, 0, 0, ...s('mif1heic')]);
  const hdlr = box('hdlr', [0, 0, 0, 0, 0, 0, 0, 0, ...s('pict'), ...new Array(12).fill(0), 0]);
  const iinf = box('iinf', [0, 0, 0, 0, ...u16(2), ...infe(1, 'hvc1'), ...infe(2, 'Exif')]);
  const idat = method === 1 ? box('idat', exifItem) : [];
  const ilocFor = (exifOffset: number) =>
    box('iloc', [
      ilocVersion, 0, 0, 0,
      0x44, 0x00, // offset 4, length 4, base 0
      ...u16(2),
      ...u16(1), ...(ilocVersion === 1 ? u16(0) : []), ...u16(0), ...u16(1), ...u32(0), ...u32(0),
      ...u16(2), ...(ilocVersion === 1 ? u16(method) : []), ...u16(0), ...u16(1), ...u32(exifOffset), ...u32(exifItem.length),
    ]);
  const metaFor = (exifOffset: number) => box('meta', [0, 0, 0, 0, ...hdlr, ...iinf, ...ilocFor(exifOffset), ...idat]);
  const head = ftyp.length + metaFor(0).length;
  const offset = method === 1 ? 8 : head + 8; // idat: relatif isi idat; mdat: absolut
  const mdat = method === 1 ? box('mdat', []) : box('mdat', exifItem);
  return Uint8Array.from([...ftyp, ...metaFor(method === 1 ? 0 : offset), ...mdat]);
}

describe('extractExif', () => {
  const tiff = buildTiff(camera(), false);
  const same = (got: Uint8Array | undefined) => expect(got && Array.from(got)).toEqual(Array.from(tiff));

  it('JPEG APP1', () => same(extractExif(jpegWith(tiff))));
  it('PNG eXIf', () => same(extractExif(pngWith(tiff))));
  it('TIFF/DNG: berkas itu sendiri', () => same(extractExif(tiff)));
  it('HEIF iloc v0 (mdat) dan v1 (idat)', () => {
    same(extractExif(heifWith(tiff, 0)));
    same(extractExif(heifWith(tiff, 1)));
    const idat = heifWith(tiff, 1, 1);
    const got = extractExif(idat);
    expect(got && Array.from(got)).toEqual(Array.from(tiff));
  });
  it('tanpa EXIF atau rusak: undefined, tidak melempar', () => {
    expect(extractExif(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toBeUndefined();
    expect(extractExif(new Uint8Array(0))).toBeUndefined();
    const broken = heifWith(tiff, 0).slice(0, 60);
    expect(extractExif(broken)).toBeUndefined();
  });

  it('hasil tulis ulang terbaca pembaca metadata kita (Orientation = 1)', () => {
    const out = rewriteExif(extractExif(jpegWith(tiff))!, { width: 8, height: 8, srgb: true })!;
    expect(readMetadata(jpegWith(out), 'jpeg').orientation).toBe(1);
    expect(readMetadata(jpegWith(tiff), 'jpeg').orientation).toBe(6);
  });
});
