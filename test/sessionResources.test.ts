import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { Session } from '../src/session/session';
import type { EngineDevice } from '../src/engine/device';

const resources = vi.hoisted(() => ({
  graphs: [] as Array<{ disposed: boolean }>,
  scratch: [] as Array<{ release: Mock }>,
  arenas: [] as Array<Record<'static' | 'stock' | 'dynamic' | 'frameState', { destroy: Mock }>>,
  barrier: undefined as Promise<void> | undefined,
  runs: 0,
}));
vi.mock('../src/engine/precisionSelfTest', () => ({ runPrecisionSelfTest: async () => ({ ok: true, maxAbsError: 0 }) }));
vi.mock('../src/engine/chain', () => ({ buildChain: () => [] }));
vi.mock('../src/host/spectral', () => ({
  precomputeArenaData: () => ({}),
  uploadArenas: () => {
    const arenas = { static: { destroy: vi.fn() }, stock: { destroy: vi.fn() }, dynamic: { destroy: vi.fn() }, frameState: { destroy: vi.fn() } };
    resources.arenas.push(arenas); return arenas;
  },
}));
vi.mock('../src/engine/graph', () => ({ RenderGraph: class {
  disposed = false;
  constructor() { resources.graphs.push(this); }
  addStage() {}
  async run(input: Float32Array) { resources.runs += 1; await resources.barrier; return input.slice(); }
  dispose() { this.disposed = true; }
}, ScratchPool: class {
  release = vi.fn();
  constructor() { resources.scratch.push(this); }
}, returnFreedMemory: () => {} }));

const image = () => ({ width: 2, height: 2, rgba: new Float32Array(16).fill(0.18),
  suggestedColorSpace: 'sRGB', encoding: 'encoded' as const, source: { format: 'png' as const, bitDepth: 8 } });
const create = () => Session.create({ assetsBaseUrl: 'public/data', engine: {
  device: { lost: new Promise(() => {}) }, maxStorageBufferBindingSize: 1024 * 1024,
} as unknown as EngineDevice });

beforeEach(() => { resources.graphs.length = 0; resources.arenas.length = 0; resources.scratch.length = 0; resources.barrier = undefined; resources.runs = 0; });

describe('Session resource lifetime', () => {
  it('reuses the unchanged comparison pixels across edits and invalidates them on size or photo changes', async () => {
    const session = await create(); session.open(image());
    const first = await session.render('preview', 2);
    session.setParams({ filmExposureEv: 1 });
    const edited = await session.render('preview', 2);
    expect(edited.original).toBe(first.original);
    const small = await session.render('preview', 1);
    expect(small.original).not.toBe(first.original);
    expect(small.original?.width).toBe(1);
    session.open(image());
    const replaced = await session.render('preview', 1);
    expect(replaced.original).not.toBe(small.original);
    await session.close();
    session.open(image());
    const reopened = await session.render('preview', 1);
    expect(reopened.original).not.toBe(replaced.original);
    session.dispose();
  });

  it('reuses preview sizes and undo states without rerunning the GPU', async () => {
    const session = await create(); session.open(image());
    await session.render('preview', 1);
    await session.render('preview', 2);
    expect(resources.runs).toBe(2);
    await session.render('preview', 1);
    expect(resources.runs).toBe(2);
    session.setParams({ filmExposureEv: 1 }); await session.render('preview', 1);
    session.setParams({ filmExposureEv: 0 });
    const restored = await session.render('preview', 1);
    expect(resources.runs).toBe(3);
    expect(restored.paramsVersion).toBe(session.paramsVersion);
    session.open(image()); await session.render('preview', 1);
    expect(resources.runs).toBe(4);
    await session.close(); session.open(image()); await session.render('preview', 1);
    expect(resources.runs).toBe(5);
    session.dispose();
  });

  it('evicts old previews instead of retaining an unlimited edit history', async () => {
    const session = await create(); session.open(image());
    for (let i = 0; i < 7; i += 1) {
      session.setParams({ filmExposureEv: i / 10 }); await session.render('preview', 1);
    }
    expect(resources.runs).toBe(7);
    session.setParams({ filmExposureEv: 0.1 }); await session.render('preview', 1);
    expect(resources.runs).toBe(7);
    session.setParams({ filmExposureEv: 0 }); await session.render('preview', 1);
    expect(resources.runs).toBe(8);
    session.dispose();
  });
  it('renders requested preview detail and a matching original without upscaling', async () => {
    const session = await create();
    session.open({ ...image(), width: 2048, height: 2, rgba: new Float32Array(2048 * 2 * 4).fill(0.18) });
    expect((await session.render('preview')).width).toBe(1024);
    const detailed = await session.render('preview', 2048);
    expect(detailed.width).toBe(2048);
    expect(detailed.original?.width).toBe(2048);
    expect(resources.scratch[0]!.release).toHaveBeenCalled();
    expect((await session.render('preview', 512)).width).toBe(512);
    expect((await session.render('preview', 4096)).width).toBe(2048);
    await expect(session.render('preview', Infinity)).rejects.toThrow(/finite/);
    session.dispose();
  });
  it('defers export cleanup until an active render releases shared scratch', async () => {
    const session = await create(); session.open(image());
    let release!: () => void;
    resources.barrier = new Promise((resolve) => { release = resolve; });
    const render = session.render('preview');
    await vi.waitFor(() => expect(resources.scratch).toHaveLength(1));
    session.releaseExport();
    expect(resources.scratch[0]!.release).not.toHaveBeenCalled();
    release(); await render;
    expect(resources.scratch[0]!.release).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('bounds the scratch-owning graph variants to four', async () => {
    const session = await create(); session.open(image());
    for (let flags = 0; flags < 8; flags += 1) {
      session.setParams({ grainEnabled: !!(flags & 1), cameraDiffusionEnabled: !!(flags & 2), printDiffusionEnabled: !!(flags & 4) });
      await session.render('preview');
      expect(resources.graphs.filter((g) => !g.disposed).length).toBeLessThanOrEqual(4);
    }
    expect(resources.graphs.length).toBe(8);
    session.dispose();
  });
  it('repeated filter edits keep only the current arena and retire its old graphs', async () => {
    const session = await create(); session.open(image());
    for (let i = 0; i < 12; i += 1) {
      session.setParams({ filterMShift: i }); await session.render('preview');
      expect(resources.graphs.filter((g) => !g.disposed)).toHaveLength(1);
      expect(resources.arenas.filter((a) => a.static.destroy.mock.calls.length === 0)).toHaveLength(1);
    }
    session.close(); await Promise.resolve();
    expect(resources.graphs.every((g) => g.disposed)).toBe(true);
    expect(resources.arenas.every((a) => Object.values(a).every((b) => b.destroy.mock.calls.length === 1))).toBe(true);
    await expect(session.render('preview')).rejects.toThrow(/belum ada gambar/);
    session.dispose();
  });

  it('keeps the preview pool across removal and stock changes, then releases it on close', async () => {
    const session = await create(); session.open(image());
    await session.render('preview');
    const pool = resources.scratch[0]!;
    const mask = new Uint8Array(4).fill(1);
    const crop = session.prepareRemoval({ width: 2, height: 2, data: mask });
    await session.applyRemoval(crop, new Float32Array(512 * 512 * 3).fill(0.5));
    await session.render('preview');
    session.setParams({ filterMShift: 1 });
    await session.render('preview');
    expect(resources.scratch).toHaveLength(1);
    expect(pool.release).not.toHaveBeenCalled();
    await session.close();
    expect(pool.release).toHaveBeenCalledOnce();
    session.dispose();
  });

  it('does not destroy resources still in use when a photo is closed', async () => {
    const session = await create(); session.open(image());
    let release!: () => void;
    resources.barrier = new Promise((r) => { release = r; });
    const render = session.render('preview');
    await vi.waitFor(() => expect(resources.graphs).toHaveLength(1));
    session.close();
    expect(resources.graphs[0]!.disposed).toBe(false);
    expect(resources.arenas[0]!.static.destroy).not.toHaveBeenCalled();
    release(); await render; await Promise.resolve();
    expect(resources.graphs[0]!.disposed).toBe(true);
    expect(session.lastFullSize()).toBeUndefined();
    session.dispose();
  });

  it('can roll back a committed candidate and continue rendering the previous photo', async () => {
    const session = await create(); session.open(image());
    const params = session.getParams();
    await session.stageOpen(1, image(), { filmExposureEv: 2 }, 16);
    expect(session.getParams()).toEqual(params);
    session.commitOpen(1); expect(session.getParams().filmExposureEv).toBe(2);
    session.discardOpen(1); expect(session.getParams()).toEqual(params);
    await expect(session.render('preview')).resolves.toMatchObject({ width: 2, height: 2 });
    session.dispose();
  });
});
