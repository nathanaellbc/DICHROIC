import { expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadAssets } from '../src/profiles/load';
import { buildRenderPlan } from '../src/params/plan';
import { precomputeArenaData, type ArenaPlan } from '../src/host/spectral';
import { BASELINE_RENDER_PARAMS } from '../src/params/renderParams';
import { acquireDevice } from '../src/engine/device';
import { NativeRenderer, type NativeRenderHost } from '../src/native/renderer';
import { gpuBufferUsage, gpuMapMode } from '../src/engine/webgpuGlobals';
import { Tap } from '../src/engine/taps';
import { encode } from 'fast-png';
import { boxDownscaleRegion } from '../src/session/downscale';

// Capture the real canonical planner/graph on Dawn. Rust replays exactly these
// WGSL descriptors and binary inputs, without replacing any numerical gate.
it('captures complete canonical film, neutral Cineon, camera and spatial graphs', async () => {
  const directory = join('artifacts', 'native-graph-trace');
  mkdirSync(directory, { recursive: true });
  const trace: Record<string, unknown>[] = [];
  let fileNumber = 0;
  const binary = (bytes: Uint8Array) => {
    const file = `${fileNumber++}.bin`;
    writeFileSync(join(directory, file), bytes);
    return file;
  };
  const bundle = await loadAssets(join('public', 'data'));
  const width = 32, height = 24;
  const rgba = Float32Array.from({ length: width * height * 4 }, (_, i) =>
    i % 4 === 3 ? 1 : Math.round(255 * (0.02 + 0.94 * ((i * 13) % 257) / 256)) / 255);
  const baseline = { ...BASELINE_RENDER_PARAMS, inputColorSpace: 'sRGB', inputCctfDecoding: true,
    grainEnabled: false, glareEnabled: false, autoExposure: false };
  const cases = [baseline,
    { ...baseline, filmEnabled: false, paper: 'lut_kodak_2383_d55' },
    { ...baseline, cameraExposureEv: 0.75, cameraHsvSaturation: 1.2 },
    { ...baseline, grainEnabled: true },
    { ...baseline, cameraDiffusionEnabled: true },
    { ...baseline, process: 'scanNegative' as const },
  ];
  // Dawn on Windows cannot safely coexist with cold, allocation-heavy Hanatos
  // preparation. Complete all CPU arenas before acquiring a GPU device.
  const prepared = new Map<string, ArenaPlan[]>();
  let lastArenaKey: string | undefined;
  for (const params of cases) {
    const plan = buildRenderPlan(params, bundle, { width, height, rgba }, 'image');
    if (lastArenaKey !== plan.arenaKey) {
      const queue = prepared.get(plan.arenaKey) ?? [];
      queue.push(precomputeArenaData(bundle, plan.arenaInputs.stockId, plan.arenaInputs.printScan));
      prepared.set(plan.arenaKey, queue);
      lastArenaKey = plan.arenaKey;
    }
  }
  const { device } = await acquireDevice();
  const gpuErrors: string[] = [];
  device.addEventListener('uncapturederror', event => gpuErrors.push(event.error.message));
  const resources = new Map<number, GPUBuffer | GPUComputePipeline | GPUBindGroup | GPUTexture | GPUTextureView | GPUSampler>();
  const pipelineLabels = new Map<number, string>();
  const groupOutputs = new Map<number, number>();
  const snapshots: Promise<void>[] = [];
  let captureLabel = '';
  let next = 1;
  const register = (resource: GPUBuffer | GPUComputePipeline | GPUBindGroup | GPUTexture | GPUTextureView | GPUSampler) => {
    const id = next++; resources.set(id, resource); return id;
  };
  const host: NativeRenderHost = {
    readAsset: name => {
      const b = readFileSync(join('public', name)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    readText: name => readFileSync(join('public', name), 'utf8'),
    sourceTile: (tile, into) => { boxDownscaleRegion(rgba, width, height, width, height,
      tile.tileOriginX, tile.tileOriginY, tile.tileWidth, tile.tileHeight, into); },
    outputTile: () => { throw new Error('Unexpected export output in preview test'); },
    progress: () => {},
    command: json => {
      const v = JSON.parse(json);
      let result: unknown = null;
      switch (v.op) {
        case 'limits': result = { maxBufferSize: device.limits.maxBufferSize,
          maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
          maxComputeWorkgroupsPerDimension: device.limits.maxComputeWorkgroupsPerDimension,
          maxTextureDimension2D: device.limits.maxTextureDimension2D }; break;
        case 'buffer': result = register(device.createBuffer({ size: v.size, usage: v.usage | gpuBufferUsage.COPY_DST })); break;
        case 'pipeline': result = register(device.createComputePipeline({ layout: 'auto',
          compute: { module: device.createShaderModule({ code: v.code }), entryPoint: v.entry } }));
          pipelineLabels.set(Number(result), v.label ?? v.entry); break;
        case 'group': result = register(device.createBindGroup({
          layout: (resources.get(v.pipeline) as GPUComputePipeline).getBindGroupLayout(v.index ?? 0),
          entries: v.entries.map((e: { binding: number; id: number; offset?: number; size?: number }) => ({ binding: e.binding,
            resource: 'offset' in e ? { buffer: resources.get(e.id) as GPUBuffer, offset: e.offset, size: e.size }
              : resources.get(e.id) as GPUTextureView | GPUSampler })),
        })); groupOutputs.set(Number(result), v.entries.find((e: { binding: number }) => e.binding === 1)?.id); break;
        case 'texture': result = register(device.createTexture({ size: [v.width, v.height], format: v.format, usage: v.usage, mipLevelCount: v.mips })); break;
        case 'view': result = register((resources.get(v.texture) as GPUTexture).createView({ baseMipLevel: v.baseMipLevel, mipLevelCount: v.mipLevelCount })); break;
        case 'sampler': result = register(device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' })); break;
        case 'submit': {
          const encoder = device.createCommandEncoder();
          for (const command of v.commands) {
            if (command.op === 'copy') encoder.copyBufferToBuffer(resources.get(command.source) as GPUBuffer, command.sourceOffset,
              resources.get(command.dest) as GPUBuffer, command.destOffset, command.size);
            else {
              const pass = encoder.beginComputePass();
              pass.setPipeline(resources.get(command.pipeline) as GPUComputePipeline);
              pass.setBindGroup(0, resources.get(command.group) as GPUBindGroup);
              pass.dispatchWorkgroups(command.x, command.y, command.z); pass.end();
            }
          }
          device.queue.submit([encoder.finish()]);
          trace.push({ kind: 'command', value: v, result });
          if (process.env.DICHROIC_TRACE_FFT === '1') for (const c of v.commands) {
            const label = pipelineLabels.get(c.pipeline);
            if (!label?.startsWith('fft:')) continue;
            const source = groupOutputs.get(c.group)!;
            const buffer = resources.get(source) as GPUBuffer;
            if (!(buffer.usage & gpuBufferUsage.COPY_SRC)) continue;
            const staging = device.createBuffer({ size: buffer.size, usage: 9 });
            const id = register(staging);
            trace.push({ kind: 'command', value: { op: 'buffer', size: buffer.size, usage: 9 }, result: id });
            const copy = device.createCommandEncoder(); copy.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
            device.queue.submit([copy.finish()]);
            trace.push({ kind: 'command', value: { op: 'submit', commands: [{ op: 'copy', source, sourceOffset: 0, dest: id, destOffset: 0, size: buffer.size }] }, result: null });
            const file = `${fileNumber++}.bin`;
            trace.push({ kind: 'read', id, offset: 0, file, label });
            trace.push({ kind: 'command', value: { op: 'destroy', id }, result: null });
            resources.delete(id);
            snapshots.push(staging.mapAsync(1).then(() => {
              writeFileSync(join(directory, file), new Uint8Array(staging.getMappedRange()));
              staging.unmap(); staging.destroy();
            }));
          }
          return JSON.stringify({ result });
        }
        case 'destroy': {
          const resource = resources.get(v.id);
          if (resource && 'destroy' in resource) resource.destroy();
          resources.delete(v.id); break;
        }
        default: throw new Error(`Unknown trace operation ${v.op}`);
      }
      trace.push({ kind: 'command', value: v, result });
      return JSON.stringify({ result });
    },
    upload: (id, offset, bytes) => {
      device.queue.writeBuffer(resources.get(id) as GPUBuffer, offset, bytes as Uint8Array<ArrayBuffer>);
      trace.push({ kind: 'upload', id, offset, file: binary(bytes) });
    },
    read: async (id, offset, size) => {
      const buffer = resources.get(id) as GPUBuffer;
      await buffer.mapAsync(gpuMapMode.READ, offset, size);
      const result = buffer.getMappedRange(offset, size).slice(0); buffer.unmap();
      trace.push({ kind: 'read', id, offset, file: binary(new Uint8Array(result)), label: captureLabel,
        domain: captureLabel.endsWith(':rgb_out') ? 'encoded-image' : 'raw' });
      return result;
    },
  };
  const renderer = new NativeRenderer(host, bundle, plan => prepared.get(plan.arenaKey)!.shift()!);
  const fixtures: { params: unknown; rgba: number[] }[] = [];
  try {
    for (const [index, params] of cases.entries()) {
      captureLabel = `case:${index}:rgb_out`;
      const rgb = await renderer.preview(params, rgba, width, height);
      expect(rgb.length).toBe(width * height * 3);
      expect(rgb.every(Number.isFinite)).toBe(true);
      if (index === 0 || index === 3) {
        const region = { x: 7, y: 5, width: 13, height: 11 };
        captureLabel = `detail:${index}:rgb_out`;
        const detail = await renderer.detail(params, width, height, { rgba, width, height }, region);
        expect(detail).toBeDefined();
        let maximum = 0;
        for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) for (let c = 0; c < 3; c++) {
          maximum = Math.max(maximum, Math.abs(detail![(y * region.width + x) * 3 + c]! - rgb[((region.y + y) * width + region.x + x) * 3 + c]!));
        }
        expect(maximum).toBeLessThanOrEqual(1e-5);
      }
      fixtures.push({ params, rgba: Array.from({ length: width * height * 4 }, (_, i) =>
        i % 4 === 3 ? 255 : Math.round(255 * Math.max(0, Math.min(1, rgb[Math.floor(i / 4) * 3 + i % 4]!)))) });
      if (index === 2 && process.env.DICHROIC_TRACE_CAMERA === '1') {
        for (const tap of [Tap.LOG_E_FILM, Tap.CMY_FILM, Tap.LOG_E_PRINT, Tap.CMY_PRINT]) {
          captureLabel = `camera:${tap}`;
          await renderer.preview(params, rgba, width, height, tap);
        }
      }
    }
  } finally { renderer.dispose(); await Promise.all(snapshots); device.destroy(); }
  expect(resources.size).toBe(0);
  expect(gpuErrors).toEqual([]);
  writeFileSync(join(directory, 'trace.json'), JSON.stringify(trace));
  // Byte fixtures exercise ImageIO -> JavaScriptCore -> Metal -> PNG on iOS.
  // Keep the independent Dawn reference, never regenerate it in the iOS test.
  if (process.env.DICHROIC_UPDATE_IOS_REFERENCE === '1') {
    const target = 'mobile/assets/parity'; mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'source.png'), encode({ width, height, channels: 4, data: Uint8Array.from(rgba, v => Math.round(v * 255)) }));
    writeFileSync(join(target, 'dawn.json'), JSON.stringify({ width, height, cases: fixtures }));
  }
}, 120000);
