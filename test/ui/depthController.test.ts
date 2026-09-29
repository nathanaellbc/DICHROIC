import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { DEPTH_STALL_MS } from '../../src/ui/engine/depthController';
import { DepthController } from '../../src/ui/engine/depthController';
import type { DepthState } from '../../src/ui/engine/depthController';
import { DepthCancelledError, DepthNotCachedError } from '../../src/depth/estimate';
import type { DepthProgress, DepthResult, Guide } from '../../src/depth/estimate';
import type { DepthMap } from '../../src/host/lens';

/**
 * Status estimasi kedalaman untuk lens blur (`Engine` -> UI grup Lens). Logika
 * dipisah dari `Engine` (yang butuh Worker dan DOM) supaya alur "belum di
 * perangkat -> unduh -> siap -> foto berganti" bisa diuji di Node.
 */

const guide = (w = 4): Guide => ({ rgba: new Uint8ClampedArray(w * 2 * 4), width: w, height: 2 });

interface Call {
  guide: Guide;
  allowDownload: boolean;
  onProgress: (p: DepthProgress) => void;
  resolve: (r: DepthResult) => void;
  reject: (e: Error) => void;
}

function harness() {
  const calls: Call[] = [];
  const delivered: DepthMap[] = [];
  const states: DepthState[] = [];
  const cancelled: number[] = [];
  const controller = new DepthController({
    cancel: () => cancelled.push(1),
    estimate: (g, allowDownload, onProgress) =>
      new Promise<DepthResult>((resolve, reject) => calls.push({ guide: g, allowDownload, onProgress, resolve, reject })),
    deliver: async (map) => {
      delivered.push(map);
    },
    downloadBytes: async () => 41_498_698,
    onChange: (s) => states.push(s),
  });
  return { controller, calls, delivered, states, cancelled };
}

const result = (w: number): DepthResult => ({
  width: w,
  height: 2,
  data: new Float32Array(w * 2).fill(0.5),
  backend: 'wasm',
  variant: 'int8',
  inferMs: 812,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('DepthController', () => {
  it('mulai idle; ensure tanpa foto tidak memanggil estimasi', () => {
    const { controller, calls } = harness();
    expect(controller.state).toEqual({ status: 'idle' });
    controller.ensure();
    expect(calls).toHaveLength(0);
  });

  it('model belum di perangkat: tidak mengunduh diam-diam, meminta unduhan dengan ukurannya', async () => {
    const { controller, calls, delivered } = harness();
    controller.reset(guide());
    controller.ensure();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.allowDownload).toBe(false);
    expect(controller.state.status).toBe('working');
    calls[0]!.reject(new DepthNotCachedError('not here'));
    await flush();
    expect(controller.state).toEqual({ status: 'needs-download', bytes: 41_498_698 });
    expect(delivered).toHaveLength(0);
  });

  it('unduh -> progres -> siap: peta dikirim ke Session sebelum status siap', async () => {
    const { controller, calls, delivered, states } = harness();
    controller.reset(guide());
    controller.download();
    expect(calls[0]!.allowDownload).toBe(true);
    calls[0]!.onProgress({ phase: 'model', loaded: 10, total: 40 });
    expect(controller.state).toEqual({ status: 'working', phase: 'model', loaded: 10, total: 40 });
    calls[0]!.resolve(result(4));
    await flush();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.width).toBe(4);
    expect(controller.state).toEqual({ status: 'ready', backend: 'wasm', variant: 'int8', ms: 812 });
    expect(states.at(-1)).toEqual(controller.state);
  });

  it('ensure saat bekerja atau siap tidak memulai estimasi kedua', async () => {
    const { controller, calls } = harness();
    controller.reset(guide());
    controller.ensure();
    controller.ensure();
    expect(calls).toHaveLength(1);
    calls[0]!.resolve(result(4));
    await flush();
    controller.ensure();
    expect(calls).toHaveLength(1);
  });

  it('foto berganti selama estimasi: hasil lama dibuang, tidak pernah dikirim ke foto baru', async () => {
    const { controller, calls, delivered } = harness();
    controller.reset(guide(4));
    controller.ensure();
    controller.reset(guide(8)); // foto berikutnya dibuka
    expect(controller.state).toEqual({ status: 'idle' });
    calls[0]!.resolve(result(4));
    await flush();
    expect(delivered).toHaveLength(0);
    expect(controller.state).toEqual({ status: 'idle' });
    controller.ensure();
    expect(calls[1]!.guide.width).toBe(8);
  });

  it('estimasi yang tersalip (DepthCancelledError) tidak menimpa status yang baru', async () => {
    const { controller, calls } = harness();
    controller.reset(guide());
    controller.ensure();
    controller.reset(guide());
    controller.download();
    calls[0]!.reject(new DepthCancelledError());
    await flush();
    expect(controller.state.status).toBe('working');
    calls[1]!.resolve(result(4));
    await flush();
    expect(controller.state.status).toBe('ready');
  });

  it('galat lain menjadi status error, dan ensure berikutnya mencoba lagi', async () => {
    const { controller, calls } = harness();
    controller.reset(guide());
    controller.ensure();
    calls[0]!.reject(new Error('The depth worker failed to start.'));
    await flush();
    expect(controller.state).toEqual({ status: 'error', message: 'The depth worker failed to start.' });
    controller.ensure();
    expect(calls).toHaveLength(2);
  });

  it('reset tanpa foto mengosongkan guide: ensure dan download tidak berbuat apa-apa', () => {
    const { controller, calls } = harness();
    controller.reset(undefined);
    controller.ensure();
    controller.download();
    expect(calls).toHaveLength(0);
  });
});

describe('DepthController: watchdog', () => {
  afterEach(() => vi.useRealTimers());

  it('tanpa progres selama DEPTH_STALL_MS: dibatalkan, worker dimatikan, status error', async () => {
    vi.useFakeTimers();
    const { controller, calls, cancelled } = harness();
    controller.reset(guide());
    controller.download();
    calls[0]!.onProgress({ phase: 'model', loaded: 40, total: 40 });
    await vi.advanceTimersByTimeAsync(DEPTH_STALL_MS - 1000);
    expect(controller.state.status).toBe('working');
    calls[0]!.onProgress({ phase: 'compile', loaded: 0, total: 1 }); // progres me-reset jam
    await vi.advanceTimersByTimeAsync(DEPTH_STALL_MS - 1000);
    expect(controller.state.status).toBe('working');
    await vi.advanceTimersByTimeAsync(2000);
    expect(controller.state.status).toBe('error');
    expect(cancelled).toHaveLength(1);
    // Hasil yang terlambat datang setelah itu diabaikan.
    calls[0]!.resolve(result(4));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.state.status).toBe('error');
  });

  it('selesai tepat waktu: jam dihentikan', async () => {
    vi.useFakeTimers();
    const { controller, calls, cancelled } = harness();
    controller.reset(guide());
    controller.ensure();
    calls[0]!.resolve(result(4));
    await vi.advanceTimersByTimeAsync(DEPTH_STALL_MS * 2);
    expect(controller.state.status).toBe('ready');
    expect(cancelled).toHaveLength(0);
  });
});

describe('entri worker kedalaman', () => {
  it('tidak memasang serveDepth di thread pthread ORT (em-pthread)', () => {
    for (const file of ['src/depth/depthGpu.worker.ts', 'src/depth/depthCpu.worker.ts']) {
      const src = readFileSync(file, 'utf8');
      const calls = src.split(/\r?\n/).filter((l) => /serveDepth\(/.test(l) && !/^\s*(import|\/\/)/.test(l));
      expect(calls, file).toHaveLength(1);
      expect(calls[0], file).toMatch(/if \(!self\.name\.startsWith\('em-pthread'\)\)/);
    }
  });
});
