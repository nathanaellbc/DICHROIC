// @verifies grainEnabled glareEnabled -- lewat Session (keduanya mati, keluarga <case>)
import { describe, it, expect, beforeAll } from 'vitest';
import { Session } from '../src/session/session';
import { RenderSupersededError, SessionStateError } from '../src/session/errors';
import type { RenderResult } from '../src/session/session';
import { UnverifiedParameterError } from '../src/params/registry';
import type { RenderParams } from '../src/params/renderParams';
import type { DecodedImage } from '../src/io/decoded';
import { compareRgb, expectWithinTolerance, loadCase, loadInputAsRgba, loadTap } from './parity/compare';
import { sharedResources } from './parity/run';
import { buildRenderPlan } from '../src/params/plan';
import { buildChain } from '../src/engine/chain';
import { RenderGraph } from '../src/engine/graph';
import { Tap } from '../src/engine/taps';
import { planTiles } from '../src/engine/tiling';
import { decodeImage } from '../src/io';
import { quantize } from '../src/io/encode';
import type { ExportFormat } from '../src/session/session';

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

  it('menjalankan self-test presisi IIR saat create dan melaporkannya', () => {
    expect(session.diagnostics.iirPrecisionOk).toBe(true);
    expect(session.diagnostics.iirMaxAbsError).toBeLessThanOrEqual(1e-6);
  });

  it('setParams dengan field locked ditolak dan parameter tidak berubah', () => {
    // `rgbToRawMethod` di luar batch parameter 1 (Hanatos2026 OFX tanpa oracle Python).
    const patch = { rgbToRawMethod: 'hanatos2026' } as unknown as Partial<RenderParams>;
    expect(() => session.setParams(patch)).toThrow(UnverifiedParameterError);
    expect(session.params.rgbToRawMethod).toBe('hanatos2025');
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
      let v = 0.02 + (0.6 * x) / width;
      if ((x >> 6) % 2 === (y >> 6) % 2) v *= 0.3; // tepi tajam untuk efek spasial
      if ((x - width / 2) ** 2 + (y - height / 2) ** 2 < 25) v = 6; // sorotan
      rgba[(y * width + x) * 4] = v;
      rgba[(y * width + x) * 4 + 1] = v * 0.9;
      rgba[(y * width + x) * 4 + 2] = v * 0.8;
      rgba[(y * width + x) * 4 + 3] = 1;
    }
  }
  return { width, height, rgba, suggestedColorSpace: 'ProPhoto RGB', encoding: 'linear', source: { format: 'fixture', bitDepth: 32 } };
}

describe('Session: pratinjau, antrean, cache', () => {
  /**
   * Penerimaan Fase 2A.5: di 2A render 1024 px masih melempar (dir.ts, radius
   * > 16) karena jalur IIR `fast_gaussian_filter` belum di-port. Sekarang
   * batas pratinjau bawaan (1024) dipakai apa adanya.
   */
  it('render pratinjau memperkecil 2048x1365 ke 1024x683 dengan batas bawaan', async () => {
    const s = await sharedSession();
    s.open(gradientImage(2048, 1365));
    s.setParams({ grainEnabled: false, glareEnabled: false });
    const result = await s.render('preview');
    expect(result.quality).toBe('preview');
    expect(result.width).toBe(1024);
    expect(result.height).toBe(683);
    expect(result.rgb.length).toBe(1024 * 683 * 3);
    for (const v of result.rgb) expect(Number.isFinite(v)).toBe(true);
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

describe('Session: prewarm', () => {
  it('tanpa gambar terbuka; graf yang dihangatkan menghasilkan render identik', async () => {
    const warm = await sharedSession();
    await warm.prewarm();
    const graphs = (warm as unknown as { graphs: Map<string, unknown> }).graphs;
    expect([...graphs.keys()].map((k) => k.split('|').slice(1).join('|')).sort()).toEqual([
      'lut|grain=false|scan=false|dc=false|dp=false',
      'measured|grain=false|scan=false|dc=false|dp=false',
      'measured|grain=true|scan=false|dc=false|dp=false',
    ]);
    const cold = await sharedSession();
    for (const s of [warm, cold]) {
      s.open(fixtureImage('gray_ramp'));
      s.setParams({ grainEnabled: false, glareEnabled: false });
    }
    const [a, b] = [await warm.render('full'), await cold.render('full')];
    expect(a.rgb).toEqual(b.rgb);
    expect(graphs.size).toBe(3);
    warm.dispose();
    cold.dispose();
  });

  it('prewarm yang menunggu tersalip permintaan berikutnya; exportCube yang tersalip diantrekan ulang', async () => {
    const s = await sharedSession();
    s.open(fixtureImage('gray_ramp'));
    const first = s.render('preview');
    const warming = s.prewarm();
    const cube = s.exportCube(5);
    const next = s.render('preview');
    const [a, w, c] = await Promise.allSettled([first, warming, cube, next.catch(() => undefined)]);
    expect(a.status).toBe('fulfilled');
    expect(w.status).toBe('rejected');
    expect((w as PromiseRejectedResult).reason).toBeInstanceOf(RenderSupersededError);
    expect(c.status).toBe('fulfilled');
    const idle = await sharedSession();
    expect((c as PromiseFulfilledResult<string>).value).toBe(await idle.exportCube(5));
    s.dispose();
    idle.dispose();
  });

  it('prewarm setelah dispose ditolak', async () => {
    const s = await sharedSession();
    s.dispose();
    await expect(s.prewarm()).rejects.toBeInstanceOf(SessionStateError);
  });
});

describe('Session: penerimaan rezim resolusi produksi', () => {
  it(
    'render penuh 2048x1365 cocok dengan render ter-tile paksa dari plan yang sama (<= 2e-6)',
    async () => {
      const s = await sharedSession();
      const image = gradientImage(2048, 1365);
      s.open(image);
      s.setParams({ grainEnabled: false, glareEnabled: false });
      const full = await s.render('full');
      expect(full.width).toBe(2048);

      const { engine, bundle, arenas } = await sharedResources(STOCK_ID, PRINT);
      const plan = buildRenderPlan(s.getParams(), bundle, image, 'image');
      expect(plan.overlap).toBeGreaterThan(256); // apron IIR, bukan konstanta OFX
      const maxBufferBytes = (700 + 2 * plan.overlap) ** 2 * 16;
      expect(planTiles(2048, 1365, maxBufferBytes, plan.overlap).length).toBeGreaterThan(1);

      const graph = new RenderGraph(engine);
      for (const stage of buildChain(engine.device, arenas, plan.chain)) graph.addStage(stage);
      const tiled = await graph.run(image.rgba, plan.core, Tap.RGB_OUT, {
        maxBufferBytes,
        overlap: plan.overlap,
        frame: plan.frame,
      });
      graph.dispose();

      let maxAbs = 0;
      for (let p = 0; p < 2048 * 1365; p += 1) {
        for (let c = 0; c < 3; c += 1) maxAbs = Math.max(maxAbs, Math.abs(tiled[p * 4 + c]! - full.rgb[p * 3 + c]!));
      }
      // Ambang rgb_out 2e-6 (<= 20% ambang parity rgb_out 1e-5), BUKAN 1e-6:
      // didiagnosis per tap (2026-09-28) -- selisih tile vs full di tap antara
      // adalah derau pembulatan f32 1-2 ulp (log_e_film 1.2e-7, cmy_film
      // 2.4e-7), lalu diperkuat bagian kurva print/scan yang curam (cmy_print
      // 8.3e-7, rgb_out 1.55e-6). Piksel terburuk rgb_out 270/517 px dari tepi
      // tile dan hanya 22 piksel > 1e-7: bukan jahitan; apron 8 vs 10 sigma
      // tidak mengubahnya. Jahitan sendiri dijaga di cmy_film (<= 1e-6,
      // tiling.test.ts).
      expect(maxAbs, `tile vs full ${maxAbs.toExponential(3)}`).toBeLessThanOrEqual(2e-6);
      s.dispose();
    },
    180_000,
  );
});

describe('Session: exportImage (rencana 2B Task 7)', () => {
  it('PNG 8/16 dan TIFF 16 = quantize(render penuh), round-trip lewat decoder io/', async () => {
    session.open(gradientImage(96, 64));
    const full = await session.render('full');
    for (const [format, bits] of [['png8', 8], ['png16', 16], ['tiff16', 16]] as const) {
      const image = await decodeImage(await session.exportImage(format));
      expect([image.width, image.height, image.source.bitDepth], format).toEqual([96, 64, bits]);
      const q = quantize(full.rgb, bits);
      const max = bits === 8 ? 255 : 65535;
      let mismatch = 0;
      for (let i = 0; i < 96 * 64; i += 1) {
        for (let c = 0; c < 3; c += 1) if (image.rgba[i * 4 + c] !== Math.fround(q[i * 3 + c]! / max)) mismatch += 1;
      }
      expect(mismatch, format).toBe(0);
    }
  });

  it('format tidak dikenal -> RangeError', async () => {
    await expect(session.exportImage('jpeg' as ExportFormat)).rejects.toBeInstanceOf(RangeError);
  });

  it('ekspor yang tersalip sebelum mulai diantrekan ulang, tidak gagal', async () => {
    session.open(gradientImage(80, 48));
    const running = session.render('preview');
    const exported = session.exportImage('png8');
    // Pratinjau ini menyalip render penuh milik ekspor; ekspor mengantre
    // ulang dan ganti menyalip pratinjau itu.
    const overtaken = session.render('preview').catch((e: unknown) => e);
    await running;
    const bytes = await exported;
    expect((await decodeImage(bytes)).width).toBe(80);
    expect(await overtaken).toBeInstanceOf(RenderSupersededError);
  });
});
