import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES_DIR = join('test', 'fixtures');
const BASE_CASE = 'gray_ramp';
const DETERMINISTIC_DIR = join(FIXTURES_DIR, BASE_CASE);
const STOCHASTIC_DIR = join(FIXTURES_DIR, `${BASE_CASE}_stochastic`);

function loadCase(dir: string) {
  return JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'));
}

function loadTap(dir: string, tap: string): Float32Array {
  const buf = readFileSync(join(dir, `${tap}.f32`));
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// Setiap kasus dasar dibangkitkan dalam dua keluarga (lihat
// tools/gen_reference.py): deterministik (grain & glare mati lewat
// debug.deactivate_stochastic_effects) dan stokastik (setelan default
// hulu). Kedua keluarga harus lulus pemeriksaan struktural yang sama.
describe.each([
  ['deterministik', DETERMINISTIC_DIR, false],
  ['stokastik', STOCHASTIC_DIR, true],
])('fixture referensi (%s)', (_label, dir, expectedStochastic) => {
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
describe('keluarga deterministik vs stokastik benar-benar berbeda', () => {
  it('rgb_out berbeda antar keluarga (glare aktif hanya di stokastik)', () => {
    const det = loadTap(DETERMINISTIC_DIR, 'rgb_out');
    const sto = loadTap(STOCHASTIC_DIR, 'rgb_out');
    expect(sto.length).toBe(det.length);
    const identical = det.every((v, i) => v === sto[i]);
    expect(identical, 'rgb_out harus berbeda antar keluarga').toBe(false);
  });

  it('cmy_film berbeda antar keluarga (grain aktif hanya di stokastik)', () => {
    const det = loadTap(DETERMINISTIC_DIR, 'cmy_film');
    const sto = loadTap(STOCHASTIC_DIR, 'cmy_film');
    expect(sto.length).toBe(det.length);
    const identical = det.every((v, i) => v === sto[i]);
    expect(identical, 'cmy_film harus berbeda antar keluarga').toBe(false);
  });

  it('rgb_pre identik antar keluarga (tap ini mendahului grain maupun glare)', () => {
    // Pemeriksaan negatif di atas bisa lolos secara kebetulan kalau
    // loadTap membaca berkas yang salah atau kosong. rgb_pre adalah tap
    // sebelum filming/scanning apa pun terjadi, jadi ia HARUS identik
    // antar keluarga -- ini membuktikan loadTap benar-benar membaca data,
    // bukan cuma selalu mengembalikan array yang "kebetulan berbeda".
    const det = loadTap(DETERMINISTIC_DIR, 'rgb_pre');
    const sto = loadTap(STOCHASTIC_DIR, 'rgb_pre');
    expect(sto).toEqual(det);
  });
});
