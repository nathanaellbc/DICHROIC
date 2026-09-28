import { describe, it, expect } from 'vitest';
import { formatCube, identityLattice, parseCube } from '../src/io/cube';
import type { CubeMeta } from '../src/io/cube';
import { readFileSync } from 'node:fs';
import { DICHROIC_VERSION } from '../src/version';

const META: CubeMeta = {
  title: 'DICHROIC test',
  film: 'kodak_portra_400',
  paper: 'kodak_portra_endura',
  inputColorSpace: 'ProPhoto RGB',
  outputColorSpace: 'sRGB',
  disabledEffects: ['halation', 'grain'],
  version: '0.1.0',
};

describe('identityLattice', () => {
  it('menyusun titik dengan R tercepat, lalu G, lalu B (urutan data .cube)', () => {
    const { rgba, width, height } = identityLattice(2);
    expect(width).toBe(4);
    expect(height).toBe(2);
    const points: number[][] = [];
    for (let i = 0; i < 8; i += 1) points.push([rgba[i * 4]!, rgba[i * 4 + 1]!, rgba[i * 4 + 2]!]);
    expect(points).toEqual([
      [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
      [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
    ]);
  });

  it('membagi rentang [0,1] rata untuk ukuran 3', () => {
    const { rgba } = identityLattice(3);
    expect([rgba[0], rgba[4], rgba[8]]).toEqual([0, 0.5, 1]);
    expect(rgba[3]).toBe(1);
  });

  it('menolak ukuran di luar 2..65 atau bukan bilangan bulat', () => {
    expect(() => identityLattice(1)).toThrow(RangeError);
    expect(() => identityLattice(66)).toThrow(RangeError);
    expect(() => identityLattice(17.5)).toThrow(RangeError);
  });
});

describe('formatCube / parseCube', () => {
  const rgb = Float32Array.from({ length: 8 * 3 }, (_, i) => i / 23);

  it('menulis header, daftar efek yang dimatikan, dan data 6 desimal', () => {
    const text = formatCube(rgb, 2, META);
    const lines = text.trimEnd().split('\n');
    expect(lines[0]).toBe('TITLE "DICHROIC test"');
    expect(text).toContain('# DICHROIC 0.1.0');
    expect(text).toContain('# film: kodak_portra_400 / paper: kodak_portra_endura');
    expect(text).toContain('# input: ProPhoto RGB / output: sRGB');
    expect(text).toContain('# disabled effects: halation, grain');
    expect(text).toContain('LUT_3D_SIZE 2');
    expect(text).toContain('DOMAIN_MIN 0 0 0');
    expect(text).toContain('DOMAIN_MAX 1 1 1');
    const data = lines.filter((l) => /^-?\d/.test(l));
    expect(data).toHaveLength(8);
    expect(data[1]).toBe('0.130435 0.173913 0.217391');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('round-trip dalam 5e-7', () => {
    const parsed = parseCube(formatCube(rgb, 2, META));
    expect(parsed.size).toBe(2);
    for (let i = 0; i < rgb.length; i += 1) expect(Math.abs(parsed.data[i]! - rgb[i]!)).toBeLessThanOrEqual(5e-7);
  });

  it('menolak data yang jumlahnya tidak cocok dengan ukuran', () => {
    expect(() => formatCube(new Float32Array(9), 2, META)).toThrow(RangeError);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n')).toThrow(/8 baris/);
  });

  it('mengganti tanda kutip di judul supaya header tetap sah', () => {
    expect(formatCube(rgb, 2, { ...META, title: 'a "b"' }).split('\n')[0]).toBe("TITLE \"a 'b'\"");
  });
});

describe('DICHROIC_VERSION', () => {
  it('sama dengan versi package.json', () => {
    expect(DICHROIC_VERSION).toBe((JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version);
  });
});
