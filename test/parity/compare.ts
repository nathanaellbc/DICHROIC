import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readF32 } from '../readF32';

// Relatif terhadap cwd proses test (spektra/), sama seperti konvensi di
// test/fixtures.test.ts. `npm test` selalu dijalankan dari spektra/.
const FIXTURES = join('test', 'fixtures');

const CHANNEL_NAMES = ['R', 'G', 'B'] as const;

export interface CaseMeta {
  name: string;
  width: number;
  height: number;
  taps: Array<{ tap: string; channels: number }>;
}

export function loadCase(name: string): CaseMeta {
  return JSON.parse(
    readFileSync(join(FIXTURES, name, 'case.json'), 'utf8'),
  ) as CaseMeta;
}

export function loadTap(name: string, tap: string): Float32Array {
  return readF32(join(FIXTURES, name, `${tap}.f32`));
}

/** Fixture menyimpan RGB rapat; engine bekerja dengan RGBA. */
export function loadInputAsRgba(name: string): Float32Array {
  const rgb = readF32(join(FIXTURES, name, 'input.f32'));
  if (rgb.length % 3 !== 0) {
    throw new Error(
      `input.f32 untuk kasus "${name}" punya panjang ${rgb.length}, ` +
        'bukan kelipatan 3 (RGB rapat).',
    );
  }
  const pixels = rgb.length / 3;
  const rgba = new Float32Array(pixels * 4);
  for (let p = 0; p < pixels; p += 1) {
    rgba[p * 4] = rgb[p * 3]!;
    rgba[p * 4 + 1] = rgb[p * 3 + 1]!;
    rgba[p * 4 + 2] = rgb[p * 3 + 2]!;
    rgba[p * 4 + 3] = 1;
  }
  return rgba;
}

export interface Comparison {
  /** Galat absolut terbesar yang ditemukan, dalam satuan channel. */
  maxAbsError: number;
  /** Rata-rata galat absolut di seluruh channel R/G/B seluruh piksel. */
  meanAbsError: number;
  /**
   * Indeks flat ke dalam `expectedRgb` (bukan `actualRgba`) tempat
   * `maxAbsError` ditemukan -- yaitu `piksel * 3 + kanal`.
   */
  worstIndex: number;
}

/**
 * Membandingkan keluaran RGBA aktual (dari engine WebGPU) dengan fixture
 * referensi RGB rapat (dari upstream Python). Hanya channel R/G/B yang
 * dibandingkan -- alpha diasumsikan selalu 1 di kedua sisi dan bukan
 * bagian dari spesifikasi upstream.
 *
 * Melempar galat (bukan diam-diam melaporkan nol) jika `actualRgba`
 * terlalu pendek untuk menutupi jumlah piksel yang diharapkan dari
 * `expectedRgb`. Ini sengaja: array yang salah ukuran adalah bug yang
 * lebih mendasar daripada galat numerik, dan tidak boleh lolos sebagai
 * "cocok" hanya karena loop berhenti lebih awal.
 */
export function compareRgb(
  actualRgba: Float32Array,
  expectedRgb: Float32Array,
): Comparison {
  if (expectedRgb.length % 3 !== 0) {
    throw new Error(
      `expectedRgb punya panjang ${expectedRgb.length}, bukan kelipatan 3.`,
    );
  }
  const pixels = expectedRgb.length / 3;
  const requiredLength = pixels * 4;
  if (actualRgba.length < requiredLength) {
    throw new Error(
      `Keluaran aktual terlalu pendek untuk dibandingkan: panjang ${actualRgba.length} ` +
        `< ${requiredLength} (${pixels} piksel x 4 channel RGBA yang diharapkan).`,
    );
  }

  let maxAbsError = 0;
  let sum = 0;
  let worstIndex = 0;

  for (let p = 0; p < pixels; p += 1) {
    for (let c = 0; c < 3; c += 1) {
      const error = Math.abs(actualRgba[p * 4 + c]! - expectedRgb[p * 3 + c]!);
      sum += error;
      if (error > maxAbsError) {
        maxAbsError = error;
        worstIndex = p * 3 + c;
      }
    }
  }

  return { maxAbsError, meanAbsError: sum / (pixels * 3), worstIndex };
}

/**
 * Menegakkan ambang toleransi. Ambang datang dari parameter panggilan,
 * bukan dari nilai baku di sini -- pemanggil di Task 11-18 menyatakan
 * ambangnya sendiri secara eksplisit per tap.
 *
 * JANGAN longgarkan ambang untuk membuat panggilan ini lulus. Python
 * upstream menghitung dalam f64 dan engine ini menghitung dalam f32,
 * jadi selisih di orde 1e-7 adalah bising floating-point yang wajar.
 * Meleset di orde 1e-3 bukan bising -- itu tanda ada perbedaan
 * struktural (urutan operasi, konvensi matriks baris vs kolom,
 * interpolasi yang keliru, dll). Cari dan perbaiki sumbernya; jangan
 * naikkan angka toleransi supaya pesan ini berhenti muncul.
 */
export function expectWithinTolerance(
  comparison: Comparison,
  tolerance: number,
  label: string,
): void {
  if (comparison.maxAbsError <= tolerance) return;

  const pixel = Math.floor(comparison.worstIndex / 3);
  const channel = CHANNEL_NAMES[comparison.worstIndex % 3];

  throw new Error(
    `${label}: max abs error ${comparison.maxAbsError.toExponential(3)} ` +
      `melebihi ambang ${tolerance.toExponential(3)} ` +
      `(mean ${comparison.meanAbsError.toExponential(3)}, ` +
      `terburuk di indeks ${comparison.worstIndex} -- piksel ${pixel}, kanal ${channel}).\n` +
      'JANGAN longgarkan ambang ini. Python menghitung f64 dan kita f32, jadi ' +
      'selisih wajar berada di orde 1e-7. Meleset sebesar ini berarti ada ' +
      'perbedaan struktural: urutan operasi, konvensi matriks baris versus ' +
      'kolom, atau interpolasi yang keliru. Temukan penyebabnya.',
  );
}
