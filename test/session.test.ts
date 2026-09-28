// @verifies grainEnabled glareEnabled -- lewat Session (keduanya mati, keluarga <case>)
import { describe, it, expect, beforeAll } from 'vitest';
import { Session } from '../src/session/session';
import { SessionStateError } from '../src/session/errors';
import { UnverifiedParameterError } from '../src/params/registry';
import type { DecodedImage } from '../src/io/decoded';
import { compareRgb, expectWithinTolerance, loadCase, loadInputAsRgba, loadTap } from './parity/compare';
import { sharedResources } from './parity/run';

/**
 * Gerbang ujung-ke-ujung lewat facade `Session` (Fase 2A Task 5): gambar
 * masuk lewat `open`, parameter lewat `setParams`, keluar `rgb_out` -- dan
 * harus cocok dengan Python dengan ambang yang SAMA seperti
 * `measuredChain.test.ts` (1e-5). Engine, bundle, dan arena memakai
 * `sharedResources` (satu device per proses; pra-hitung arena sebelum
 * device -- CATATAN LINGKUNGAN `src/host/spectral.ts`).
 */

const STOCK_ID = 'kodak_portra_400';
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

/** Semua Session di berkas ini berbagi device dan arena yang dipra-hitung sebelum device hidup. */
async function sharedSession(): Promise<Session> {
  const { engine, bundle } = await sharedResources(STOCK_ID, PRINT);
  return Session.create({
    assetsBaseUrl: 'public/data',
    engine,
    bundle,
    arenaProvider: {
      get: async (_key, inputs) => (await sharedResources(inputs.stockId, inputs.printScan)).arenas,
    },
  });
}

beforeAll(async () => {
  session = await sharedSession();
});

function fixtureImage(name: string): DecodedImage {
  const meta = loadCase(name);
  return {
    width: meta.width,
    height: meta.height,
    rgba: loadInputAsRgba(name),
    suggestedColorSpace: 'ProPhoto RGB',
    encoding: 'linear',
    source: { format: 'fixture', bitDepth: 32, name },
  };
}

function rgbToRgba(rgb: Float32Array): Float32Array {
  const out = new Float32Array((rgb.length / 3) * 4);
  for (let p = 0; p < rgb.length / 3; p += 1) out.set([rgb[p * 3]!, rgb[p * 3 + 1]!, rgb[p * 3 + 2]!, 1], p * 4);
  return out;
}

describe('Session: urutan pemakaian', () => {
  it('render sebelum open gagal dengan SessionStateError', async () => {
    const fresh = await sharedSession();
    await expect(fresh.render('full')).rejects.toBeInstanceOf(SessionStateError);
  });

  it('setParams dengan field locked ditolak dan parameter tidak berubah', () => {
    expect(() => session.setParams({ filmExposureEv: 2 })).toThrow(UnverifiedParameterError);
    expect(session.params.filmExposureEv).toBe(0);
  });
});

describe('Session: rgb_out cocok dengan referensi Python', () => {
  for (const name of ['gray_ramp', 'log_gray_ramp', 'color_patches']) {
    it(name, async () => {
      session.open(fixtureImage(name));
      session.setParams({ grainEnabled: false, glareEnabled: false });
      const result = await session.render('full');
      expect(result.quality).toBe('full');
      expect(result.width).toBe(loadCase(name).width);
      expect(result.rgb.length).toBe(result.width * result.height * 3);
      expectWithinTolerance(
        compareRgb(rgbToRgba(result.rgb), loadTap(name, 'rgb_out')),
        1e-5,
        `Session rgb_out / ${name}`,
      );
    });
  }
});

describe('Session: dispose', () => {
  it('render setelah dispose gagal dengan SessionStateError', async () => {
    const s = await sharedSession();
    s.open(fixtureImage('gray_ramp'));
    s.dispose();
    await expect(s.render('full')).rejects.toBeInstanceOf(SessionStateError);
  });
});
