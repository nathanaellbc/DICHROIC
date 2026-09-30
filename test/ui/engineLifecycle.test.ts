import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreparedPhoto, RenderResult } from '../../src/session/session';
import { BASELINE_RENDER_PARAMS } from '../../src/params/renderParams';
import { DecodeError } from '../../src/io/errors';

const client = vi.hoisted(() => ({
  init: vi.fn(), getDiagnostics: vi.fn(), prewarm: vi.fn(), decode: vi.fn(),
  stageOpen: vi.fn(), commitOpen: vi.fn(), finishOpen: vi.fn(), discardOpen: vi.fn(),
  setParams: vi.fn(), render: vi.fn(), close: vi.fn(),
  dispose: vi.fn(), shutdown: vi.fn(),
  renderExport: vi.fn(), exportImage: vi.fn(), exportCube: vi.fn(), lastFullSize: vi.fn(),
}));
vi.mock('../../src/session/client', () => ({ SessionClient: { attach: () => client } }));
vi.mock('../../src/depth/model', () => ({ depthProfile: async () => ({ backend: 'wasm', guideMaxEdge: 16 }), firstDownloadBytes: async () => 1 }));
import { Engine } from '../../src/ui/engine/engine';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const frame: RenderResult = { width: 1, height: 1, rgb: Float32Array.of(0.5, 0.5, 0.5), quality: 'preview', paramsVersion: 0 };
const photo: PreparedPhoto = {
  width: 1, height: 1, params: { ...BASELINE_RENDER_PARAMS }, preview: frame,
  original: { width: 1, height: 1, pixels: new Uint8ClampedArray(4), colorSpace: 'srgb' },
  guide: { width: 1, height: 1, rgba: new Uint8ClampedArray(4) },
};
const file = (name: string) => ({ name, arrayBuffer: async () => new ArrayBuffer(8) }) as File;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('Worker', class {});
  vi.stubGlobal('window', { location: { href: 'https://app.test/' } });
  client.init.mockResolvedValue(undefined);
  client.getDiagnostics.mockResolvedValue({ iirPrecisionOk: true });
  client.prewarm.mockResolvedValue(undefined);
  client.decode.mockResolvedValue({ width: 1, height: 1, rgba: new Float32Array(4), encoding: 'encoded', suggestedColorSpace: 'sRGB', source: { format: 'png', bitDepth: 8 } });
  client.stageOpen.mockResolvedValue(photo);
  for (const f of [client.commitOpen, client.finishOpen, client.discardOpen, client.setParams, client.close, client.dispose]) f.mockResolvedValue(undefined);
  client.render.mockResolvedValue(frame);
});
afterEach(() => vi.unstubAllGlobals());

describe('photo lifecycle', () => {
  it.each(['renderExport', 'exportImage', 'exportCube'] as const)('rejects %s completed after the photo closes', async (method) => {
    const engine = new Engine(); await engine.openFile(file('first.png'));
    const pending = deferred<unknown>(); client[method].mockReturnValueOnce(pending.promise);
    const result = method === 'renderExport' ? engine.renderExport(16, { width: 16, height: 16 })
      : method === 'exportImage' ? engine.exportImage('png8') : engine.exportCube(16);
    engine.closePhoto(); pending.resolve(method === 'renderExport' ? { width: 16, height: 16 }
      : method === 'exportImage' ? new Uint8Array(0) : 'cube');
    await expect(result).rejects.toMatchObject({ name: 'RenderSupersededError' });
  });

  it('two failed edits never restore an unconfirmed intermediate value', async () => {
    const engine = new Engine(); await engine.openFile(file('first.png'));
    client.setParams.mockRejectedValueOnce(new Error('invalid')).mockRejectedValueOnce(new Error('invalid'));
    engine.setParams({ filmExposureEv: 4 }); engine.setParams({ filmExposureEv: 5 }); await flush();
    expect(engine.getState().params.filmExposureEv).toBe(BASELINE_RENDER_PARAMS.filmExposureEv);
  });

  it('a worker constructor failure remains retryable', async () => {
    vi.stubGlobal('Worker', class { constructor() { throw new Error('blocked worker'); } });
    const engine = new Engine();
    await engine.openFile(file('first.png'));
    expect(engine.getState()).toMatchObject({ engine: 'failed', phase: 'idle' });
    vi.stubGlobal('Worker', class {});
    await engine.openFile(file('first.png'));
    expect(engine.getState().phase).toBe('editing');
  });

  it('initialization completing after close cannot reactivate the retired worker', async () => {
    const pending = deferred<void>(); client.init.mockReturnValueOnce(pending.promise);
    const engine = new Engine(); engine.start(); engine.closePhoto();
    pending.resolve(); await flush();
    expect(engine.getState()).toMatchObject({ engine: 'paused', phase: 'idle' });
    expect(client.prewarm).not.toHaveBeenCalled();
  });

  it('rejected edits roll back to confirmed parameters', async () => {
    const engine = new Engine(); await engine.openFile(file('first.png'));
    client.setParams.mockRejectedValueOnce(new Error('invalid exposure'));
    engine.setParams({ filmExposureEv: 4 }); await flush();
    expect(engine.getState().params.filmExposureEv).toBe(BASELINE_RENDER_PARAMS.filmExposureEv);
  });

  it('retains the editor after a failed replacement decode', async () => {
    const engine = new Engine(); engine.start();
    await engine.openFile(file('first.png'));
    client.decode.mockRejectedValueOnce(new DecodeError('png', 'damaged'));
    await engine.openFile(file('bad.png'));
    expect(engine.getState()).toMatchObject({ phase: 'editing', fileName: 'first.png' });
  });

  it('cancelled preparation never commits the candidate', async () => {
    const engine = new Engine(); engine.start();
    await engine.openFile(file('first.png'));
    const pending = deferred<PreparedPhoto>();
    client.stageOpen.mockReturnValueOnce(pending.promise);
    const opening = engine.openFile(file('cancelled.png'));
    await flush(); engine.cancelOpening(); pending.resolve(photo); await opening;
    expect(client.commitOpen).toHaveBeenCalledTimes(1);
    expect(engine.getState()).toMatchObject({ phase: 'editing', fileName: 'first.png', opening: undefined });
  });

  it('cancelling during commit rolls back the worker transaction', async () => {
    const engine = new Engine(); engine.start();
    await engine.openFile(file('first.png'));
    const pending = deferred<void>();
    client.commitOpen.mockReturnValueOnce(pending.promise);
    const opening = engine.openFile(file('cancelled.png'));
    await flush(); engine.cancelOpening(); pending.resolve(); await opening;
    expect(client.discardOpen).toHaveBeenCalledWith(2);
    expect(engine.getState().fileName).toBe('first.png');
  });

  it('a preview completed after close cannot resurrect the photo', async () => {
    const engine = new Engine(); engine.start();
    await engine.openFile(file('first.png'));
    const pending = deferred<RenderResult>();
    client.render.mockReturnValueOnce(pending.promise);
    engine.requestRender(); engine.closePhoto(); pending.resolve(frame); await flush();
    expect(engine.getState()).toMatchObject({ phase: 'idle', frame: undefined, fileName: undefined });
    expect(engine.imageSize).toBeUndefined();
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it('an old parameter render cannot overwrite a newer edit', async () => {
    const engine = new Engine(); engine.start(); await engine.openFile(file('first.png'));
    const before = engine.getState().frame;
    const pending = deferred<RenderResult>();
    client.render.mockReturnValueOnce(pending.promise);
    engine.requestRender(); engine.setParams({ filmExposureEv: 1 });
    client.render.mockReturnValueOnce(new Promise(() => {}));
    pending.resolve({ ...frame, rgb: Float32Array.of(1, 0, 0) }); await flush();
    expect(engine.getState().frame).toBe(before);
  });
});
