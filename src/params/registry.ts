/**
 * Registri status per field `RenderParams` (spec Fase 2 §4.1).
 *
 * `verified`: nilai apa pun boleh; ada gerbang parity yang menyebut field ini
 * lewat penanda `@verifies <field>` di `test/` (dijaga `renderParams.test.ts`).
 * `locked`: hanya nilai baseline yang boleh.
 *
 * Tidak ada jalur yang meneruskan nilai tak terverifikasi ke engine: nilai
 * yang ditolak di sini adalah nilai yang tidak pernah diadu dengan Python,
 * dan memakainya diam-diam berarti menampilkan gambar yang kebenarannya tidak
 * kita ketahui.
 */

import { BASELINE_RENDER_PARAMS } from './renderParams';
import type { RenderParams } from './renderParams';

export type FieldStatus = 'verified' | 'locked';

export const FIELD_STATUS: Readonly<Record<keyof RenderParams, FieldStatus>> = Object.freeze({
  film: 'locked',
  paper: 'locked',
  rgbToRawMethod: 'locked',
  inputColorSpace: 'locked',
  inputCctfDecoding: 'locked',
  outputColorSpace: 'locked',
  // Fase 2C Task 2: param/exposure_* (`test/parity/exposure.test.ts`).
  autoExposure: 'verified',
  filmExposureEv: 'verified',
  printExposureEv: 'verified',
  // Fase 2C Task 4: param/pushpull_* (`test/parity/pushPull.test.ts`), mode Standard.
  filmPushPullStops: 'verified',
  // Fase 2C Task 3: param/enlarger_* (`test/parity/enlarger.test.ts`).
  filterC: 'verified',
  filterMShift: 'verified',
  filterYShift: 'verified',
  // Fase 2C Task 5: param/halation_* (`test/parity/halationParams.test.ts`).
  halationEnabled: 'verified',
  halationAmount: 'verified',
  // Keluarga `<case>` (keduanya mati, `measuredChain.test.ts`) dan
  // `<case>_stochastic` (keduanya hidup, `grain.test.ts`,
  // `scannerPostGlare.test.ts`) -- lih. aturan kombinasi di bawah.
  grainEnabled: 'verified',
  // Fase 2C Task 7: param/grain_*, format_* (`test/parity/grainParams.test.ts`).
  grainAmount: 'verified',
  grainSeed: 'verified',
  filmFormat: 'verified',
  cameraDiffusionEnabled: 'locked',
  cameraDiffusionFamily: 'locked',
  cameraDiffusionStrength: 'locked',
  printDiffusionEnabled: 'locked',
  printDiffusionFamily: 'locked',
  printDiffusionStrength: 'locked',
  glareEnabled: 'verified',
  // Fase 2C Task 6: param/glare_*, grain_* (`test/parity/glare.test.ts`).
  glarePercent: 'verified',
  // Fase 2C Task 6: param/unsharp_* (`test/parity/unsharp.test.ts`).
  scannerUnsharpAmount: 'verified',
});

export class UnverifiedParameterError extends Error {
  constructor(
    readonly field: keyof RenderParams,
    readonly value: unknown,
    readonly baseline: unknown,
    reason?: string,
  ) {
    super(
      `Parameter "${field}" = ${String(value)} belum digerbangi parity ` +
        `(hanya ${String(baseline)} yang terverifikasi)` +
        (reason ? `: ${reason}` : '.'),
    );
    this.name = 'UnverifiedParameterError';
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return typeof a === 'number' && typeof b === 'number' ? Object.is(a, b) : a === b;
}

export function validateRenderParams(p: RenderParams): void {
  for (const field of Object.keys(FIELD_STATUS) as Array<keyof RenderParams>) {
    if (FIELD_STATUS[field] === 'locked' && !sameValue(p[field], BASELINE_RENDER_PARAMS[field])) {
      throw new UnverifiedParameterError(field, p[field], BASELINE_RENDER_PARAMS[field]);
    }
  }
  // Fase 1 menggerbangi grain dan glare HANYA bersamaan. Fase 2C Task 6
  // menggerbangi campurannya (`test/parity/glare.test.ts`: glare tanpa grain,
  // grain tanpa glare lewat percent 0), jadi keempat kombinasi terverifikasi
  // dan aturan kopling lama dilepas.
}

/** Terapkan patch lalu validasi; `current` tidak pernah dimutasi. */
export function applyParamsPatch(current: RenderParams, patch: Partial<RenderParams>): RenderParams {
  // Patch bisa datang lewat RPC tanpa jaminan tipe: kunci salah ketik atau
  // tipe yang keliru harus gagal keras, bukan diam-diam tanpa efek.
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(FIELD_STATUS, key)) {
      throw new TypeError(`Parameter tidak dikenal: "${key}".`);
    }
    const expected = typeof BASELINE_RENDER_PARAMS[key as keyof RenderParams];
    if (typeof value !== expected) {
      throw new TypeError(`Parameter "${key}" harus bertipe ${expected}, diterima ${typeof value}.`);
    }
  }
  const next: RenderParams = { ...current, ...patch };
  validateRenderParams(next);
  return next;
}
