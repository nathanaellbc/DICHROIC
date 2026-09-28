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
  autoExposure: 'locked',
  filmExposureEv: 'locked',
  printExposureEv: 'locked',
  filmPushPullStops: 'locked',
  filterC: 'locked',
  filterMShift: 'locked',
  filterYShift: 'locked',
  halationEnabled: 'locked',
  halationAmount: 'locked',
  // Keluarga `<case>` (keduanya mati, `measuredChain.test.ts`) dan
  // `<case>_stochastic` (keduanya hidup, `grain.test.ts`,
  // `scannerPostGlare.test.ts`) -- lih. aturan kombinasi di bawah.
  grainEnabled: 'verified',
  grainAmount: 'locked',
  grainSeed: 'locked',
  filmFormat: 'locked',
  cameraDiffusionEnabled: 'locked',
  cameraDiffusionFamily: 'locked',
  cameraDiffusionStrength: 'locked',
  printDiffusionEnabled: 'locked',
  printDiffusionFamily: 'locked',
  printDiffusionStrength: 'locked',
  glareEnabled: 'verified',
  glarePercent: 'locked',
  scannerUnsharpAmount: 'locked',
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
  // Fase 1 menggerbangi grain dan glare HANYA bersamaan (keduanya mati di
  // `deactivate_stochastic_effects`, keduanya hidup di default). Campuran
  // tidak pernah dibangkitkan Python.
  if (p.grainEnabled !== p.glareEnabled) {
    throw new UnverifiedParameterError(
      'glareEnabled',
      p.glareEnabled,
      p.grainEnabled,
      'glare dan grain hanya terverifikasi bila keduanya sama-sama hidup atau mati',
    );
  }
}

/** Terapkan patch lalu validasi; `current` tidak pernah dimutasi. */
export function applyParamsPatch(current: RenderParams, patch: Partial<RenderParams>): RenderParams {
  const next: RenderParams = { ...current, ...patch };
  validateRenderParams(next);
  return next;
}
