import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { readF32 } from './readF32';

const FIXTURES_DIR = join('test', 'fixtures');
const BASE_CASES = [
  'gray_ramp', 'log_gray_ramp', 'hard_edge', 'impulse_highlight', 'color_patches',
] as const;

const detDir = (base: string) => join(FIXTURES_DIR, base);
const stoDir = (base: string) => join(FIXTURES_DIR, `${base}_stochastic`);

function loadCase(dir: string) {
  return JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'));
}

// Review seluruh-branch agenda #4: dulu alias lokal (`new Float32Array(buf.
// buffer, buf.byteOffset, ...)`), sekarang `readF32` bersama -- lih.
// `test/readF32.ts` untuk kenapa varian SALIN dipilih sebagai basis
// ekstraksi (bukan alias, yang rapuh terhadap alignment kolam Buffer Node).
function loadTap(dir: string, tap: string): Float32Array {
  return readF32(join(dir, `${tap}.f32`));
}

// Setiap kasus dasar dibangkitkan dalam dua keluarga (lihat
// tools/gen_reference.py): deterministik (grain & glare mati lewat
// debug.deactivate_stochastic_effects) dan stokastik (setelan default
// hulu). Semua lima kasus dasar x kedua keluarga harus lulus pemeriksaan
// struktural yang sama -- sebelumnya hanya gray_ramp yang diperiksa di
// sini, jadi delapan dari sepuluh direktori fixture tidak punya satu pun
// pemeriksaan otomatis (hanya tertangkap oleh audit manual sekali jalan).
const ALL_CASE_DIRS: Array<[string, string, boolean]> = BASE_CASES.flatMap((base) => [
  [`${base} (deterministik)`, detDir(base), false],
  [`${base} (stokastik)`, stoDir(base), true],
]);

describe.each(ALL_CASE_DIRS)('fixture referensi (%s)', (_label, dir, expectedStochastic) => {
  it('case.json menandai keluarga dengan benar', () => {
    const meta = loadCase(dir);
    expect(meta.stochastic).toBe(expectedStochastic);
  });

  it('case.json cocok dengan ukuran berkas f32', () => {
    const meta = loadCase(dir);
    for (const { tap, channels } of meta.taps) {
      const bytes = readFileSync(join(dir, `${tap}.f32`)).byteLength;
      expect(bytes, `${tap} byte length`).toBe(
        meta.width * meta.height * channels * 4,
      );
    }
  });

  it('tidak ada nilai tak hingga di tap mana pun', () => {
    const meta = loadCase(dir);
    for (const { tap } of meta.taps) {
      const values = loadTap(dir, tap);
      expect(values.every(Number.isFinite), `${tap} finite`).toBe(true);
    }
  });
});

// Requirement eksplisit dari ruling koordinator: kalau fixture
// deterministik dan stokastik untuk kasus yang sama ternyata identik,
// saklar debug.deactivate_stochastic_effects tidak bekerja seperti yang
// diasumsikan, dan seluruh pembagian dua-keluarga ini salah. Ini bukan
// pemeriksaan ukuran berkas -- ia membaca nilai piksel sungguhan dan
// menuntut mereka BERBEDA, persis kebalikan dari pemeriksaan determinisme.
// Diperiksa untuk kelima kasus dasar, bukan cuma gray_ramp.
describe.each(BASE_CASES)('keluarga deterministik vs stokastik benar-benar berbeda (%s)', (base) => {
  const det = detDir(base);
  const sto = stoDir(base);

  it('rgb_out berbeda antar keluarga (glare aktif hanya di stokastik)', () => {
    const d = loadTap(det, 'rgb_out');
    const s = loadTap(sto, 'rgb_out');
    expect(s.length).toBe(d.length);
    const identical = d.every((v, i) => v === s[i]);
    expect(identical, 'rgb_out harus berbeda antar keluarga').toBe(false);
  });

  it('cmy_film berbeda antar keluarga (grain aktif hanya di stokastik)', () => {
    const d = loadTap(det, 'cmy_film');
    const s = loadTap(sto, 'cmy_film');
    expect(s.length).toBe(d.length);
    const identical = d.every((v, i) => v === s[i]);
    expect(identical, 'cmy_film harus berbeda antar keluarga').toBe(false);
  });

  it('rgb_pre identik antar keluarga (tap ini mendahului grain maupun glare)', () => {
    // Pemeriksaan negatif di atas bisa lolos secara kebetulan kalau
    // loadTap membaca berkas yang salah atau kosong. rgb_pre adalah tap
    // sebelum filming/scanning apa pun terjadi, jadi ia HARUS identik
    // antar keluarga -- ini membuktikan loadTap benar-benar membaca data,
    // bukan cuma selalu mengembalikan array yang "kebetulan berbeda".
    const d = loadTap(det, 'rgb_pre');
    const s = loadTap(sto, 'rgb_pre');
    expect(s).toEqual(d);
  });
});

// Manifes checksum (test/fixtures/manifest.json, ditulis oleh
// gen_reference.py --manifest) mengunci determinisme: siapa pun yang
// membangkitkan ulang dan mendapat hash berbeda tahu ada yang berubah,
// entah di hulu, di venv, atau di generator -- bukan cuma diklaim sekali
// lewat audit manual. Ia juga menutup celah yang sama dengan pemeriksaan
// struktural di atas: setiap berkas fixture diverifikasi, bukan hanya
// yang kebetulan disebut di case.json.
describe('manifes checksum fixture', () => {
  const manifestPath = join(FIXTURES_DIR, 'manifest.json');
  const manifest: Record<string, string> = JSON.parse(readFileSync(manifestPath, 'utf8'));

  function allFixtureFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        allFixtureFiles(full, acc);
      } else if (entry !== 'manifest.json') {
        acc.push(relative(FIXTURES_DIR, full).split(sep).join('/'));
      }
    }
    return acc;
  }

  it('manifes tidak kosong', () => {
    expect(Object.keys(manifest).length).toBeGreaterThan(0);
  });

  // it.each atas entri manifes: kalau satu berkas rusak atau terpotong,
  // nama test itu sendiri menyebutkan berkas mana yang gagal -- bukan
  // cuma "sesuatu tidak cocok" di satu assertion raksasa.
  it.each(Object.entries(manifest))('%s cocok dengan sha256 di manifes', (relPath, expectedHash) => {
    const bytes = readFileSync(join(FIXTURES_DIR, relPath));
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    expect(actualHash, `sha256 ${relPath}`).toBe(expectedHash);
  });

  it('manifes mencakup persis semua berkas fixture di disk (tidak kurang, tidak lebih)', () => {
    const onDisk = allFixtureFiles(FIXTURES_DIR).sort();
    const listed = Object.keys(manifest).sort();
    expect(onDisk).toEqual(listed);
  });
});
