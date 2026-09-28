// @verifies grainEnabled glareEnabled -- lewat Session (keduanya mati, keluarga <case>)
import { describe, it, expect, beforeAll } from 'vitest';
import { Session } from '../src/session/session';
import { RenderSupersededError, SessionStateError } from '../src/session/errors';
import type { RenderResult } from '../src/session/session';
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
async function sharedSession(extra: { previewMaxLongEdge?: number } = {}): Promise<Session> {
  const { engine, bundle } = await sharedResources(STOCK_ID, PRINT);
  return Session.create({
    ...extra,
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

function gradientImage(width: number, height: number): DecodedImage {
  const rgba = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = 0.02 + (0.6 * x) / width;
      rgba.set([v, v * 0.9, v * 0.8, 1], (y * width + x) * 4);
    }
  }
  return { width, height, rgba, suggestedColorSpace: 'ProPhoto RGB', encoding: 'linear', source: { format: 'fixture', bitDepth: 32 } };
}

describe('Session: pratinjau, antrean, cache', () => {
  /**
   * Batas bawaan 1024 px dikunci `downscale.test.ts`. Render GPU di 1024 px
   * BELUM mungkin: blur spasial hulu beralih ke IIR Young-van Vliet pada
   * sigma >= 3 px (`fast_gaussian_filter.py::SMALL_SIGMA_MAX`) dan jalur itu
   * belum di-port (dir.ts melempar di radius > 16). Test render 1024 px
   * adalah test penerimaan Fase 2A.5 (rezim resolusi produksi). Di sini
   * batasnya diturunkan ke 256 px, masih dalam rezim FIR yang terverifikasi.
   */
  it('render pratinjau memperkecil sisi terpanjang ke batas pratinjau', async () => {
    const s = await sharedSession({ previewMaxLongEdge: 256 });
    s.open(gradientImage(2048, 32));
    s.setParams({ grainEnabled: false, glareEnabled: false });
    const result = await s.render('preview');
    expect(result.quality).toBe('preview');
    expect(result.width).toBe(256);
    expect(result.height).toBe(4);
    expect(result.rgb.length).toBe(256 * 4 * 3);
    s.dispose();
  });

  it('permintaan yang tersalip sebelum mulai ditolak RenderSupersededError; pertama dan terakhir selesai', async () => {
    const s = await sharedSession();
    s.open(fixtureImage('gray_ramp'));
    const first = s.render('preview');
    s.setParams({ grainEnabled: false, glareEnabled: false });
    const second = s.render('preview');
    s.setParams({ grainEnabled: true, glareEnabled: true });
    const third = s.render('preview');
    const [a, b, c] = await Promise.allSettled([first, second, third]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('rejected');
    expect((b as PromiseRejectedResult).reason).toBeInstanceOf(RenderSupersededError);
    expect(c.status).toBe('fulfilled');
    expect((c as PromiseFulfilledResult<RenderResult>).value.paramsVersion).toBe(s.paramsVersion);
    s.dispose();
  });

  it('hasil untuk parameter dan gambar yang sama diambil dari cache', async () => {
    const s = await sharedSession();
    s.open(fixtureImage('gray_ramp'));
    s.setParams({ grainEnabled: false, glareEnabled: false });
    const r1 = await s.render('full');
    const r2 = await s.render('full');
    expect(r2).toBe(r1);
    s.setParams({ grainEnabled: true, glareEnabled: true });
    const r3 = await s.render('full');
    expect(r3).not.toBe(r1);
    expect(r3.paramsVersion).toBeGreaterThan(r1.paramsVersion);
    s.open(fixtureImage('gray_ramp'));
    expect(await s.render('full')).not.toBe(r3);
    s.dispose();
  });

  it('hasil yang parameternya berubah selama render tetap membawa versi lama', async () => {
    const s = await sharedSession();
    s.open(fixtureImage('gray_ramp'));
    const before = s.paramsVersion;
    const pending = s.render('full');
    s.setParams({ grainEnabled: false, glareEnabled: false });
    const result = await pending;
    expect(result.paramsVersion).toBe(before);
    expect(s.paramsVersion).toBe(before + 1);
    s.dispose();
  });
});
