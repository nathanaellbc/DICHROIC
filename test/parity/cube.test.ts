import { describe, it, expect, beforeAll } from 'vitest';
import { Session } from '../../src/session/session';
import { parseCube } from '../../src/io/cube';
import { expectWithinTolerance, loadCase, loadInputAsRgba, loadTap } from './compare';
import type { Comparison } from './compare';
import { sharedResources } from './run';
import { buildRenderPlan } from '../../src/params/plan';
import type { AssetBundle } from '../../src/profiles/load';

/**
 * Gerbang parity `.cube` (Fase 2A Task 7): kubus 17^3 dari
 * `Session.exportCube` dibandingkan titik per titik dengan `rgb_out` Python
 * untuk lattice yang sama di bawah `lut_mode` (`identity_lattice_17_lut`,
 * `tools/gen_reference.py --lattice-case`). Ambang 1e-5 = Gate A `_lut`
 * (`scannerPost.test.ts`); pembulatan 6 desimal format `.cube` (5e-7) jauh
 * di bawahnya.
 *
 * ANGKA INFORMATIF (bukan gerbang, diukur 2026-09-28): kubus 65^3 yang
 * diterapkan trilinear ke input `color_patches` meleset dari `rgb_out`
 * `color_patches_lut` sampai 9.1e-3 untuk patch di dalam domain [0,1], dan
 * 3.1e-2 bila patch 2.0 (di luar domain, ter-clamp) ikut dihitung. Penyebab:
 * input baseline ProPhoto LINEAR -- lattice rata di ruang linear menyisakan
 * sangat sedikit titik di bayangan. Ini sifat .cube pada input linear, bukan
 * galat engine; relevan untuk UI (sarankan colour space input log saat
 * ekspor kubus, setelah `inputColorSpace` terverifikasi di batch 1).
 */

const PRINT = {
  printStockId: 'kodak_portra_endura',
  enlargerFilters: {
    cFilterNeutral: 0,
    mFilterNeutral: 51.56801468495496,
    mFilterShift: 0,
    yFilterNeutral: 52.53400422349596,
    yFilterShift: 0,
  },
};

let session: Session;

let bundle: AssetBundle;

beforeAll(async () => {
  const shared = await sharedResources('kodak_portra_400', PRINT);
  const { engine } = shared;
  bundle = shared.bundle;
  session = await Session.create({
    assetsBaseUrl: 'public/data',
    engine,
    bundle,
    arenaProvider: {
      get: async (_key, inputs) => (await sharedResources(inputs.stockId, inputs.printScan)).arenas,
    },
  });
});

function compareFlat(actual: Float32Array, expected: Float32Array): Comparison {
  let maxAbsError = 0;
  let sum = 0;
  let worstIndex = 0;
  for (let i = 0; i < expected.length; i += 1) {
    const e = Math.abs(actual[i]! - expected[i]!);
    sum += e;
    if (e > maxAbsError) {
      maxAbsError = e;
      worstIndex = i;
    }
  }
  return { maxAbsError, meanAbsError: sum / expected.length, worstIndex };
}

describe('parity: .cube (lattice 17^3, lut_mode)', () => {
  it('setiap titik kubus cocok dengan rgb_out Python', async () => {
    const text = await session.exportCube(17);
    const { size, data } = parseCube(text);
    expect(size).toBe(17);
    const expected = loadTap('identity_lattice_17_lut', 'rgb_out');
    expect(data.length).toBe(expected.length);
    expectWithinTolerance(compareFlat(data, expected), 1e-5, '.cube / identity_lattice_17_lut');
  });

  it('header mencatat efek yang dimatikan', async () => {
    const text = await session.exportCube(2);
    // Kubus tidak bisa membawa efek spasial/stokastik maupun ekstensi yang
    // bergantung isi gambar (camera raw mengukur pivot, lens blur butuh peta
    // kedalaman) -- daftar lengkap dari plan, bukan salinan di sini.
    const plan = buildRenderPlan(session.getParams(), bundle, { width: 2, height: 2, rgba: new Float32Array(16) }, 'cube');
    expect(plan.disabledEffects).toEqual(expect.arrayContaining(['camera raw', 'lens blur', 'halation', 'grain', 'camera diffusion', 'print diffusion']));
    expect(text).toContain(`# disabled effects: ${plan.disabledEffects.join(', ')}`);
    expect(text).toContain('LUT_3D_SIZE 2');
  });

  it('input lattice Python identik dengan identityLattice(17)', () => {
    const meta = loadCase('identity_lattice_17_lut');
    expect([meta.width, meta.height]).toEqual([289, 17]);
    const rgba = loadInputAsRgba('identity_lattice_17_lut');
    // Titik ke-18 = (r=0, g=1, b=0) -> (0, 1/16, 0).
    expect([rgba[17 * 4], rgba[17 * 4 + 1], rgba[17 * 4 + 2]]).toEqual([0, Math.fround(1 / 16), 0]);
  });
});
