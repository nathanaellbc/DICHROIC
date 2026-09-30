import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as Ort from 'onnxruntime-web';
import { serveDepth } from '../../src/depth/workerCore';
import type { DepthRequest } from '../../src/depth/protocol';
import { fetchCached, DepthAssetNotCachedError, VARIANTS, variantUrl } from '../../src/depth/model';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('depth download consent', () => {
  it('continues CPU fallback even if releasing a failed GPU session rejects', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('caches', { open: async () => ({ match: async () => new Response(Uint8Array.of(1)) }) });
    const worker = { location: { href: 'https://app.test/' }, postMessage: vi.fn(), onmessage: undefined as unknown };
    vi.stubGlobal('self', worker);
    const release = vi.fn().mockRejectedValue(new Error('GPU device lost during release'));
    const dispose = vi.fn();
    const output = { dims: [1, 1, 1], getData: async () => Float32Array.of(0.5), dispose };
    const common = { inputNames: ['input'], outputNames: ['depth'] };
    const create = vi.fn().mockResolvedValueOnce({ ...common, release, run: async () => { throw new Error('GPU lost'); } })
      .mockResolvedValueOnce({ ...common, run: async () => ({ depth: output }) });
    serveDepth({ env: { wasm: {} }, Tensor: class { dispose = dispose; }, InferenceSession: { create } } as unknown as typeof Ort,
      'https://app.test/runtime.wasm', 1);
    await (worker.onmessage as (e: { data: DepthRequest }) => Promise<void>)({ data: {
      type: 'estimate', id: 1, backend: 'webgpu', allowDownload: false, lowMemory: false,
      width: 1, height: 1, inputSize: 28, rgba: new Uint8ClampedArray(4),
    } });
    expect(release).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'result', backend: 'wasm' }), expect.any(Array));
  });

  it.each(['none', 'model', 'runtime'] as const)('never fetches when only %s is cached', async (cached) => {
    const runtimeUrl = 'https://app.test/runtime.wasm';
    const modelUrl = variantUrl(VARIANTS.wasm);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('caches', { open: async () => ({ match: async (url: string) =>
      (cached === 'model' && url === modelUrl) || (cached === 'runtime' && url === runtimeUrl) ? new Response(new Uint8Array(1)) : undefined }) });
    const worker = { location: { href: 'https://app.test/' }, postMessage: vi.fn(), onmessage: undefined as unknown };
    vi.stubGlobal('self', worker);
    serveDepth({ env: { wasm: {} } } as typeof Ort, runtimeUrl, 1);
    await (worker.onmessage as (e: { data: DepthRequest }) => Promise<void>)({ data: {
      type: 'estimate', id: 1, backend: 'wasm', allowDownload: false, lowMemory: false,
      width: 1, height: 1, inputSize: 28, rgba: new Uint8ClampedArray(4),
    } });
    expect(fetch).not.toHaveBeenCalled();
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', code: 'not-cached' }), []);
  });

  it('cache eviction does not authorize a network fallback', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('caches', { open: async () => ({ match: async () => undefined }) });
    await expect(fetchCached('https://app.test/model', 1, undefined, false)).rejects.toBeInstanceOf(DepthAssetNotCachedError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
