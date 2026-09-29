import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeJpeg, quantTable } from '../../src/io/jpegEncoder';
import { decodeJpegPixels } from '../../src/io/jpegDecoder';
import { buildIccProfile } from '../../src/io/icc';
import { iccDescription, readMetadata } from '../../src/io/metadata';
import type { OutputColorSpaceSpec } from '../../src/profiles/types';

/**
 * Encoder JPEG ekspor (tanpa kanvas: tanpa batas 16,7 MP iOS, dengan EXIF dan
 * ICC). Oracle decode: `jpegDecoder.ts`, yang digerbangi bit-identik terhadap
 * libjpeg-turbo (2B). Diverifikasi juga sekali lewat Pillow (lihat commit).
 */

function scene(w: number, h: number): Float32Array {
  const rgb = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 3;
      rgb[i] = x / (w - 1);
      rgb[i + 1] = y / (h - 1);
      rgb[i + 2] = 0.5 + 0.4 * Math.sin(x / 5) * Math.cos(y / 7);
      if ((x >> 4) % 2 === (y >> 4) % 2) rgb[i + 1] = rgb[i + 1]! * 0.4;
    }
  }
  return rgb;
}

function psnr(rgb: Float32Array, decoded: Uint8Array | Uint8ClampedArray, channels: number): number {
  let se = 0;
  const n = rgb.length / 3;
  for (let p = 0; p < n; p += 1) {
    for (let c = 0; c < 3; c += 1) {
      const want = Math.round(Math.min(1, Math.max(0, rgb[p * 3 + c]!)) * 255);
      const d = decoded[p * channels + c]! - want;
      se += d * d;
    }
  }
  return 10 * Math.log10((255 * 255) / (se / (n * 3)));
}

const manifest = JSON.parse(readFileSync(join('public', 'data', 'manifest.json'), 'utf8')) as {
  outputColorSpaces: Record<string, OutputColorSpaceSpec>;
};

describe('encodeJpeg', () => {
  it('kualitas 100, 4:4:4: nyaris lossless (PSNR > 50 dB)', () => {
    const rgb = scene(96, 64);
    const jpg = encodeJpeg(rgb, 96, 64, { quality: 100 });
    expect([jpg[0], jpg[1]]).toEqual([0xff, 0xd8]);
    expect([jpg[jpg.length - 2], jpg[jpg.length - 1]]).toEqual([0xff, 0xd9]);
    const px = decodeJpegPixels(jpg);
    expect([px.width, px.height]).toEqual([96, 64]);
    expect(psnr(rgb, px.data, px.channels)).toBeGreaterThan(50);
  });

  it('kualitas 100 memakai 4:4:4; kualitas 80 memakai 4:2:0 dan lebih kecil', () => {
    const rgb = scene(96, 64);
    const hi = encodeJpeg(rgb, 96, 64, { quality: 100 });
    const lo = encodeJpeg(rgb, 96, 64, { quality: 80 });
    const sampling = (jpg: Uint8Array) => {
      for (let o = 2; o < jpg.length - 1; o += 1) if (jpg[o] === 0xff && jpg[o + 1] === 0xc0) return jpg[o + 11]!; // faktor sampling Y
      return -1;
    };
    expect(sampling(hi)).toBe(0x11);
    expect(sampling(lo)).toBe(0x22);
    expect(lo.length).toBeLessThan(hi.length);
    expect(psnr(rgb, decodeJpegPixels(lo).data, decodeJpegPixels(lo).channels)).toBeGreaterThan(32);
  });

  it('dimensi ganjil (bukan kelipatan blok) utuh', () => {
    for (const [w, h] of [[37, 23], [1, 1], [17, 9]] as const) {
      const rgb = scene(Math.max(w, 2), Math.max(h, 2)).subarray(0, w * h * 3);
      for (const q of [100, 80]) {
        const px = decodeJpegPixels(encodeJpeg(rgb, w, h, { quality: q }));
        expect([px.width, px.height], `${w}x${h} q${q}`).toEqual([w, h]);
      }
    }
  });

  it('nilai di luar [0,1] dan NaN dijepit, tidak membungkus', () => {
    const rgb = Float32Array.from([2, -1, Number.NaN, 0.5, 1.5, -0.2]);
    const px = decodeJpegPixels(encodeJpeg(rgb, 2, 1, { quality: 100 }));
    expect(Math.abs(px.data[0]! - 255)).toBeLessThanOrEqual(2);
    expect(px.data[1]!).toBeLessThanOrEqual(2);
    expect(px.data[2]!).toBeLessThanOrEqual(2);
  });

  it('menyematkan EXIF (APP1) dan ICC (APP2) yang terbaca balik', () => {
    const icc = buildIccProfile(manifest.outputColorSpaces['Display P3']!, 'Display P3');
    // EXIF minimal: IFD0 dengan Orientation = 6 (dipakai untuk membuktikan terbaca).
    const exif = Uint8Array.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
    const jpg = encodeJpeg(scene(32, 16), 32, 16, { quality: 95, exif, icc });
    const meta = readMetadata(jpg, 'jpeg');
    expect(meta.orientation).toBe(6);
    expect(meta.iccDescription).toBe('Display P3');
    expect(iccDescription(icc)).toBe('Display P3');
    expect(decodeJpegPixels(jpg).width).toBe(32);
  });

  it('ICC besar dipecah ke beberapa APP2 dan tersusun kembali', () => {
    const big = new Uint8Array(150_000);
    const base = buildIccProfile(manifest.outputColorSpaces['sRGB']!, 'sRGB');
    big.set(base);
    new DataView(big.buffer).setUint32(0, big.length);
    const jpg = encodeJpeg(scene(16, 16), 16, 16, { quality: 90, icc: big });
    let app2 = 0;
    for (let o = 2; o + 1 < jpg.length; o += 1) if (jpg[o] === 0xff && jpg[o + 1] === 0xe2) app2 += 1;
    expect(app2).toBe(3);
    expect(readMetadata(jpg, 'jpeg').iccDescription).toBe('sRGB');
  });

  it('skala kualitas = libjpeg (nilai tabel luma Pillow q75/q50/q100)', () => {
    const luma = [16, 11, 10, 16, 24, 40, 51, 61];
    expect(Array.from(quantTable(luma, 75))).toEqual([8, 6, 5, 8, 12, 20, 26, 31]);
    expect(Array.from(quantTable(luma, 50))).toEqual(luma);
    expect(Array.from(quantTable(luma, 100))).toEqual(new Array(8).fill(1));
    expect(Math.max(...quantTable([99], 1))).toBe(255); // baseline: dijepit 255
  });

  it('tabel Huffman DHT lengkap: setiap simbol AC/DC yang mungkin punya kode', () => {
    const jpg = encodeJpeg(scene(16, 16), 16, 16, { quality: 90 });
    const tables: Array<{ cls: number; values: number[] }> = [];
    for (let o = 2; o + 3 < jpg.length; ) {
      const marker = jpg[o + 1]!;
      const len = (jpg[o + 2]! << 8) | jpg[o + 3]!;
      if (marker === 0xc4) {
        const body = jpg.subarray(o + 4, o + 2 + len);
        const counts = Array.from(body.subarray(1, 17));
        const n = counts.reduce((a, b) => a + b, 0);
        // Kraft: panjang kode membentuk pohon prefiks yang sah (dan tidak ada kode semua-1).
        const kraft = counts.reduce((s, c, i) => s + c / 2 ** (i + 1), 0);
        expect(kraft).toBeLessThan(1);
        tables.push({ cls: body[0]! >> 4, values: Array.from(body.subarray(17, 17 + n)) });
      }
      if (marker === 0xda) break;
      o += 2 + len;
    }
    expect(tables).toHaveLength(4);
    const acSymbols = [0x00, 0xf0];
    for (let r = 0; r < 16; r += 1) for (let s = 1; s <= 10; s += 1) acSymbols.push((r << 4) | s);
    for (const t of tables) {
      const want = t.cls === 0 ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] : acSymbols;
      expect([...t.values].sort((a, b) => a - b)).toEqual([...want].sort((a, b) => a - b));
    }
  });
});
