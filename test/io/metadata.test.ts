import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import { decodeImage } from '../../src/io';
import type { DecodedImage } from '../../src/io/decoded';
import { applyOrientation, colorSpaceForIcc, iccDescription, readMetadata, type Orientation } from '../../src/io/metadata';
import { loadIoInput } from './ioFixtures';
import { buildTiff } from './tiffBuilder';

/** Gambar w x h dengan nilai piksel = indeks (x, y) yang bisa dilacak. */
function tagged(w: number, h: number): DecodedImage {
  const rgba = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) rgba.set([x, y, 0, 1], (y * w + x) * 4);
  }
  return { width: w, height: h, rgba, suggestedColorSpace: 'sRGB', encoding: 'encoded', source: { format: 'png', bitDepth: 8 } };
}

/** Matriks [y][x] berisi "x,y" sumber, untuk dibandingkan dengan transformasi acuan. */
function grid(image: DecodedImage): string[][] {
  const rows: string[][] = [];
  for (let y = 0; y < image.height; y += 1) {
    const row: string[] = [];
    for (let x = 0; x < image.width; x += 1) {
      const p = (y * image.width + x) * 4;
      row.push(`${image.rgba[p]},${image.rgba[p + 1]}`);
    }
    rows.push(row);
  }
  return rows;
}

// Acuan independen dari operasi dasar matriks (definisi EXIF 2.32 Tabel 6).
const mirror = (g: string[][]) => g.map((r) => [...r].reverse());
const flip = (g: string[][]) => [...g].reverse();
const transpose = (g: string[][]) => g[0]!.map((_, x) => g.map((r) => r[x]!));
const rotateCw = (g: string[][]) => mirror(transpose(g));
const EXPECTED: Record<Orientation, (g: string[][]) => string[][]> = {
  1: (g) => g,
  2: mirror,
  3: (g) => flip(mirror(g)),
  4: flip,
  5: transpose,
  6: rotateCw,
  7: (g) => flip(mirror(transpose(g))),
  8: (g) => flip(transpose(g)),
};

/** Segmen APP1 Exif berisi IFD0 dengan Orientation. */
function exifSegment(orientation: number): Uint8Array {
  const tiff = buildTiff([{ tag: 274, type: 3, values: [orientation] }]);
  const body = new Uint8Array(6 + tiff.length);
  body.set([0x45, 0x78, 0x69, 0x66, 0, 0]);
  body.set(tiff, 6);
  return segment(0xe1, body);
}

function segment(marker: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length);
  out.set([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]);
  out.set(body, 4);
  return out;
}

function insertAfterSoi(jpeg: Uint8Array, ...segments: Uint8Array[]): Uint8Array {
  const extra = segments.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(jpeg.length + extra);
  out.set(jpeg.subarray(0, 2));
  let at = 2;
  for (const s of segments) {
    out.set(s, at);
    at += s.length;
  }
  out.set(jpeg.subarray(2), at);
  return out;
}

/** Profil ICC minimal: header 128 byte + satu tag `desc` (v2 ASCII atau v4 mluc). */
function iccProfile(description: string, kind: 'desc' | 'mluc'): Uint8Array {
  let tag: Uint8Array;
  if (kind === 'desc') {
    tag = new Uint8Array(12 + description.length + 1 + 67);
    tag.set([...'desc'].map((c) => c.charCodeAt(0)));
    new DataView(tag.buffer).setUint32(8, description.length + 1);
    tag.set([...description].map((c) => c.charCodeAt(0)), 12);
  } else {
    tag = new Uint8Array(28 + description.length * 2);
    const v = new DataView(tag.buffer);
    tag.set([...'mluc'].map((c) => c.charCodeAt(0)));
    v.setUint32(8, 1);
    v.setUint32(12, 12);
    tag.set([...'enUS'].map((c) => c.charCodeAt(0)), 16);
    v.setUint32(20, description.length * 2);
    v.setUint32(24, 28);
    [...description].forEach((c, i) => v.setUint16(28 + i * 2, c.charCodeAt(0)));
  }
  const profile = new Uint8Array(144 + tag.length);
  const v = new DataView(profile.buffer);
  v.setUint32(0, profile.length);
  profile.set([...'acsp'].map((c) => c.charCodeAt(0)), 36);
  v.setUint32(128, 1);
  profile.set([...'desc'].map((c) => c.charCodeAt(0)), 132);
  v.setUint32(136, 144);
  v.setUint32(140, tag.length);
  profile.set(tag, 144);
  return profile;
}

function iccSegments(icc: Uint8Array, parts: number): Uint8Array[] {
  const size = Math.ceil(icc.length / parts);
  return Array.from({ length: parts }, (_, i) => {
    const chunk = icc.subarray(i * size, (i + 1) * size);
    const body = new Uint8Array(14 + chunk.length);
    body.set([...'ICC_PROFILE'].map((c) => c.charCodeAt(0)));
    body[12] = i + 1;
    body[13] = parts;
    body.set(chunk, 14);
    return segment(0xe2, body);
  });
}

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, body.length);
  out.set([...type].map((c) => c.charCodeAt(0)), 4);
  out.set(body, 8);
  return out; // CRC tidak dibaca oleh readMetadata
}

function insertAfterIhdr(png: Uint8Array, chunk: Uint8Array): Uint8Array {
  const at = 8 + 25; // signature + IHDR (13 byte data)
  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, at));
  out.set(chunk, at);
  out.set(png.subarray(at), at + chunk.length);
  return out;
}

describe('applyOrientation', () => {
  for (const o of [1, 2, 3, 4, 5, 6, 7, 8] as Orientation[]) {
    it(`Orientation ${o} sama dengan transformasi acuan`, () => {
      const image = tagged(3, 2);
      const out = applyOrientation(image, o);
      expect(grid(out)).toEqual(EXPECTED[o](grid(image)));
      expect([out.width, out.height]).toEqual(o >= 5 ? [2, 3] : [3, 2]);
    });
  }
});

describe('readMetadata', () => {
  it('JPEG: Orientation dari APP1 Exif', () => {
    const jpeg = insertAfterSoi(loadIoInput('jpeg_baseline_q90'), exifSegment(6));
    expect(readMetadata(jpeg, 'jpeg').orientation).toBe(6);
  });

  it('JPEG tanpa Exif -> 1; nilai di luar 1..8 -> 1', () => {
    expect(readMetadata(loadIoInput('jpeg_baseline_q90'), 'jpeg').orientation).toBe(1);
    expect(readMetadata(insertAfterSoi(loadIoInput('jpeg_baseline_q90'), exifSegment(9)), 'jpeg').orientation).toBe(1);
  });

  it('JPEG: profil ICC yang terpecah di beberapa APP2 disambung sesuai urutan', () => {
    const icc = iccProfile('Display P3', 'mluc');
    const [a, b, c] = iccSegments(icc, 3);
    const jpeg = insertAfterSoi(loadIoInput('jpeg_baseline_q90'), c!, a!, b!);
    expect(readMetadata(jpeg, 'jpeg').iccDescription).toBe('Display P3');
  });

  it('PNG: eXIf dan iCCP', () => {
    const png = loadIoInput('png_rgb8');
    expect(readMetadata(insertAfterIhdr(png, pngChunk('eXIf', buildTiff([{ tag: 274, type: 3, values: [8] }]))), 'png').orientation).toBe(8);
    const icc = iccProfile('Adobe RGB (1998)', 'desc');
    const body = new Uint8Array([...[...'ICC'].map((c) => c.charCodeAt(0)), 0, 0, ...zlibSync(icc)]);
    expect(readMetadata(insertAfterIhdr(png, pngChunk('iCCP', body)), 'png').iccDescription).toBe('Adobe RGB (1998)');
  });

  it('TIFF: Orientation IFD0, little dan big endian', () => {
    expect(readMetadata(buildTiff([{ tag: 274, type: 3, values: [3] }]), 'tiff').orientation).toBe(3);
    expect(readMetadata(buildTiff([{ tag: 274, type: 3, values: [5] }], { bigEndian: true }), 'tiff').orientation).toBe(5);
  });

  it('metadata rusak tidak melempar', () => {
    const broken = insertAfterSoi(loadIoInput('jpeg_baseline_q90'), segment(0xe1, new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49])));
    expect(readMetadata(broken, 'jpeg')).toEqual({ orientation: 1 });
    expect(iccDescription(new Uint8Array(10))).toBeUndefined();
  });
});

describe('colorSpaceForIcc', () => {
  it.each([
    ['Display P3', 'Display P3'],
    ['sRGB IEC61966-2.1', 'sRGB'],
    ['Adobe RGB (1998)', 'Adobe RGB (1998)'],
    ['Compatible with Adobe RGB (1998)', 'Adobe RGB (1998)'],
    ['ProPhoto RGB', 'ProPhoto RGB'],
    ['Generic Gray Gamma 2.2 Profile', undefined],
    ['Rec. ITU-R BT.2020-1', undefined],
  ])('%s -> %s', (description, label) => {
    expect(colorSpaceForIcc(description)).toBe(label);
  });
});

describe('decodeImage menerapkan metadata', () => {
  it('JPEG Orientation 6 = decode tanpa tag lalu diputar 90 searah jarum jam', async () => {
    const plain = loadIoInput('jpeg_baseline_q90');
    const base = await decodeImage(plain);
    const rotated = await decodeImage(insertAfterSoi(plain, exifSegment(6)));
    expect([rotated.width, rotated.height]).toEqual([base.height, base.width]);
    expect(rotated.rgba).toEqual(applyOrientation(base, 6).rgba);
  });

  it('JPEG ber-ICC Display P3 disarankan Display P3; tanpa ICC tetap sRGB', async () => {
    const plain = loadIoInput('jpeg_baseline_q90');
    expect((await decodeImage(plain)).suggestedColorSpace).toBe('sRGB');
    const p3 = await decodeImage(insertAfterSoi(plain, ...iccSegments(iccProfile('Display P3', 'desc'), 1)));
    expect(p3.suggestedColorSpace).toBe('Display P3');
    expect(p3.encoding).toBe('encoded');
  });
});
