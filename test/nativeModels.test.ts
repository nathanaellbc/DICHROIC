// Lens blur depth and Refine Edge in the native host (iOS): the bundled
// renderer.js runs the web depth/matte code against a fake ONNX Runtime host.
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { beforeAll, expect, it } from 'vitest';

const W = 96, H = 64;
type Meta = { name: string; type: string; dims: number[] };

function bootHost(cached: boolean) {
  const calls: string[] = [];
  const completed = new Map<number, unknown>();
  const progress: string[] = [];
  let matte: { json: string; length: number } | undefined;
  let outputs: Float32Array[] = [];
  const sessions = new Map<number, string>();
  // Photo: bright subject on the left, dark background on the right.
  const pixel = (x: number) => (x < W / 2 ? 0.8 : 0.1);
  const host = {
    readText: (name: string) => readFileSync(`public/${name}`, 'utf8'),
    readAsset: (name: string) => { const b = readFileSync(`public/${name}`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    command: () => JSON.stringify({ result: { maxStorageBufferBindingSize: 32 * 1024 * 1024 } }),
    sourceRegion: (x: number, _y: number, w: number, h: number) => {
      const out = new Float32Array(w * h * 4);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) { const v = pixel(x + i); out.set([v, v, v, 1], (j * w + i) * 4); }
      return out;
    },
    sourceSamples: () => new Float32Array(512 * 512 * 4),
    complete: (id: number, json: string) => completed.set(id, JSON.parse(json)),
    depthProgress: (phase: string) => progress.push(phase),
    publishMatte: (rgba: Uint8ClampedArray, json: string) => { matte = { json, length: rgba.length }; },
    ortOpen: (url: string, _bytes: number, allowDownload: boolean, gpu: boolean) => {
      calls.push(`open ${url.includes('vitmatte') ? 'matte' : 'depth'} ${allowDownload} ${gpu}`);
      if (!cached && !allowDownload) return -1;
      const id = sessions.size + 1; sessions.set(id, url); return id;
    },
    ortNames: () => JSON.stringify({ inputs: ['input'], outputs: ['output'] }),
    ortRun: (id: number, metaJson: string, buffers: Float32Array[]) => {
      const meta = JSON.parse(metaJson) as Meta[];
      const [, , h, w] = meta[0]!.dims as [number, number, number, number];
      if (sessions.get(id)!.includes('vitmatte')) {
        // Alpha = the trimap plane (fourth channel of the input).
        outputs = [buffers[0]!.slice(3 * w * h, 4 * w * h)];
        return JSON.stringify([{ name: 'output', type: 'float32', dims: [1, 1, h, w] }]);
      }
      // Disparity: near (large) on the left half, far on the right.
      const oh = 37, ow = 56, depth = new Float32Array(ow * oh);
      for (let j = 0; j < oh; j++) for (let i = 0; i < ow; i++) depth[j * ow + i] = i < ow / 2 ? 5 : 1;
      outputs = [depth];
      return JSON.stringify([{ name: 'predicted_depth', type: 'float32', dims: [1, oh, ow] }]);
    },
    ortOutput: (i: number) => outputs[i]!.buffer.slice(0),
    ortClose: (id: number) => { sessions.delete(id); calls.push('close'); },
  };
  const context = createContext({ nativeHost: host });
  runInContext(readFileSync('ios/Sources/DichroicEngine/Resources/renderer.js', 'utf8'), context);
  runInContext('runtime = ExposureHost.createNativeRuntime(nativeHost)', context);
  runInContext(`runtime.attachSource(JSON.stringify({ width: ${W}, height: ${H}, encoding: 'encoded', suggestedColorSpace: 'sRGB' })); runtime.commitSource()`, context);
  const task = async (id: number, request: object) => {
    context.request = JSON.stringify(request);
    runInContext(`runtime.task(${id}, request)`, context);
    for (let i = 0; i < 50 && !completed.has(id); i++) await new Promise(resolve => setTimeout(resolve, 10));
    return completed.get(id) as { result?: Record<string, unknown>; error?: string; code?: string };
  };
  return { context, calls, progress, task, matte: () => matte };
}

beforeAll(() => { execFileSync(process.execPath, ['ios/scripts/build_host.mjs']); }, 60000);

it('catalog lists the depth networks the app can run, and the matte model', () => {
  const { context } = bootHost(true);
  const catalog = JSON.parse(runInContext('runtime.catalog()', context) as string) as {
    depthModels: { id: string; bytes: number; experimental: boolean }[]; matteModel: { url: string; bytes: number } };
  expect(catalog.depthModels.map(m => m.id)).toEqual(['fast', 'detail']);
  expect(catalog.depthModels[1]!.experimental).toBe(true);
  expect(catalog.matteModel.url).toContain('vitmatte');
}, 30000);

it('depth asks before downloading, then measures with the web pipeline', async () => {
  const host = bootHost(false);
  expect(await host.task(1, { operation: 'depth', model: 'fast', allowDownload: false, gpu: false })).toMatchObject({ code: 'not-cached' });
  const done = await host.task(2, { operation: 'depth', model: 'fast', allowDownload: true, gpu: true });
  expect(done.error).toBeUndefined();
  expect(done.result).toMatchObject({ model: 'fast', backend: 'gpu' });
  expect(host.progress).toEqual(expect.arrayContaining(['model', 'infer', 'refine']));
  // Sessions are always released (memory on the phone).
  expect(host.calls.filter(c => c === 'close')).toHaveLength(1);
}, 30000);

it('Refine Edge mattes the brushed band and can be removed again', async () => {
  const host = bootHost(true);
  expect((await host.task(1, { operation: 'refine', allowDownload: true })).error).toBe('Lens blur needs a depth map first.');
  await host.task(2, { operation: 'depth', model: 'fast', allowDownload: false, gpu: false });
  // Brush a vertical band over the subject edge (preview resolution).
  const mw = 48, mh = 32, mask = new Uint8Array(mw * mh);
  for (let y = 4; y < 28; y++) for (let x = 20; x < 28; x++) mask[y * mw + x] = 1;
  host.context.mask = mask.buffer;
  runInContext(`runtime.setRefineMask(JSON.stringify({ width: ${mw}, height: ${mh} }), mask)`, host.context);
  const done = await host.task(3, { operation: 'refine', allowDownload: false });
  expect(done.error).toBeUndefined();
  const rect = done.result as { x: number; y: number; w: number; h: number; width: number; height: number };
  expect(rect.x).toBeGreaterThan(0.35); expect(rect.x + rect.w).toBeLessThan(0.65);
  expect(runInContext('runtime.hasRefine()', host.context)).toBe(true);
  expect(host.matte()!.length).toBe(rect.width * rect.height * 4);
  expect(host.calls).toContain('open matte false false');
  runInContext('runtime.clearRefine()', host.context);
  expect(runInContext('runtime.hasRefine()', host.context)).toBe(false);
}, 30000);
