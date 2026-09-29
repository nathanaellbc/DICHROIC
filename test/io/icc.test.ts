import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIccProfile, parseIccForTest } from '../../src/io/icc';
import { iccDescription } from '../../src/io/metadata';
import type { OutputColorSpaceSpec } from '../../src/profiles/types';

/**
 * Profil ICC keluaran (v4, matrix/TRC) dibangun dari definisi colour space
 * yang SAMA dengan yang dipakai `scannerPost.wgsl` untuk meng-encode
 * (`manifest.outputColorSpaces`: matriks RGB->XYZ, titik putih, jenis
 * encoding). Acuan kolorant D50: nilai profil sRGB IEC61966-2.1 dan Display
 * P3 yang dipakai luas (ICC/Apple), toleransi pembulatan s15Fixed16 dan
 * perbedaan matriks sumber (~2e-3).
 */

const manifest = JSON.parse(readFileSync(join('public', 'data', 'manifest.json'), 'utf8')) as {
  outputColorSpaces: Record<string, OutputColorSpaceSpec>;
};
const spaces = manifest.outputColorSpaces;
const D50 = [0.9642, 1, 0.8249];

describe('buildIccProfile', () => {
  it('struktur v4 yang sah: ukuran, signature acsp, kelas monitor, RGB -> XYZ', () => {
    const icc = buildIccProfile(spaces['sRGB']!, 'sRGB');
    const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
    expect(view.getUint32(0)).toBe(icc.length);
    expect(icc.length % 4).toBe(0);
    expect(String.fromCharCode(...icc.subarray(36, 40))).toBe('acsp');
    expect(String.fromCharCode(...icc.subarray(12, 16))).toBe('mntr');
    expect(String.fromCharCode(...icc.subarray(16, 20))).toBe('RGB ');
    expect(String.fromCharCode(...icc.subarray(20, 24))).toBe('XYZ ');
    expect(view.getUint8(8)).toBe(4); // versi mayor 4
  });

  it('deskripsi terbaca lagi oleh pembaca ICC kita (dan dipetakan balik ke label)', () => {
    expect(iccDescription(buildIccProfile(spaces['Display P3']!, 'Display P3'))).toBe('Display P3');
  });

  it('kolorant sRGB = profil sRGB IEC61966-2.1 (D50)', () => {
    const p = parseIccForTest(buildIccProfile(spaces['sRGB']!, 'sRGB'));
    const ref = { r: [0.4361, 0.2225, 0.0139], g: [0.3851, 0.7169, 0.0971], b: [0.1431, 0.0606, 0.7141] };
    for (const k of ['r', 'g', 'b'] as const) for (let i = 0; i < 3; i += 1) expect(Math.abs(p.colorants[k][i]! - ref[k][i]!), `${k}${i}`).toBeLessThan(2e-3);
    // s15Fixed16: resolusi 1/65536.
    const want = { type: 3, g: 2.4, a: 1 / 1.055, b: 0.055 / 1.055, c: 1 / 12.92, d: 0.04045 };
    for (const [k, v] of Object.entries(want)) expect(Math.abs(p.trc[k]! - v), `trc.${k}`).toBeLessThan(2e-5);
  });

  it('kolorant Display P3 = profil Display P3 Apple (D50)', () => {
    const p = parseIccForTest(buildIccProfile(spaces['Display P3']!, 'Display P3'));
    const ref = { r: [0.5151, 0.2412, -0.0011], g: [0.292, 0.6922, 0.0419], b: [0.1571, 0.0666, 0.7841] };
    for (const k of ['r', 'g', 'b'] as const) for (let i = 0; i < 3; i += 1) expect(Math.abs(p.colorants[k][i]! - ref[k][i]!), `${k}${i}`).toBeLessThan(2e-3);
  });

  it('setiap ruang keluaran: kolorant dijumlah = putih D50, TRC sesuai encoding shader', () => {
    for (const [label, spec] of Object.entries(spaces)) {
      const p = parseIccForTest(buildIccProfile(spec, label));
      for (let i = 0; i < 3; i += 1) {
        const sum = p.colorants.r[i]! + p.colorants.g[i]! + p.colorants.b[i]!;
        expect(Math.abs(sum - D50[i]!), `${label} putih ${i}`).toBeLessThan(2e-4);
      }
      const expected =
        spec.encoding === 'srgb' ? { type: 3, g: 2.4 }
        : spec.encoding === 'romm' ? { type: 3, g: 1.8, c: 1 / 16, d: 1 / 32 }
        : spec.encoding === 'gamma' ? { type: 0, g: spec.gamma }
        : { type: 0, g: 1 };
      for (const [k, v] of Object.entries(expected)) {
        expect(Math.abs((p.trc as Record<string, number>)[k]! - (v as number)), `${label} trc.${k}`).toBeLessThan(2e-5);
      }
    }
  });

  it('deterministik: byte identik untuk masukan yang sama', () => {
    expect(buildIccProfile(spaces['sRGB']!, 'sRGB')).toEqual(buildIccProfile(spaces['sRGB']!, 'sRGB'));
  });
});
