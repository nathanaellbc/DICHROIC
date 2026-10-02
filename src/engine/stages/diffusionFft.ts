import { Tap } from '../taps';
import type { FrameParams, Stage, StageContext } from '../graph';
import { gpuBufferUsage } from '../webgpuGlobals';
import { diffusionRadius, precomputeDiffusionFilter, strengthToScatter } from '../../host/diffusionFilter';
import type { DiffusionFilterConfig, PrecomputedDiffusionFilter } from '../../host/diffusionFilter';
import source from '../../shaders/fft.wgsl?raw';

/**
 * Filter difusi kamera/enlarger lewat konvolusi FFT 2D df64 (Fase 2D Task 4),
 * port `apply_diffusion_filter_um` Python:
 *
 *   p_s    = _strength_to_scatter(strength, family)
 *   r      = min(ceil(max(8 * lambda_max_px, 5)), max(min(h, w) // 2 - 1, 1))
 *   out    = (1 - p_s) * image + p_s * fftconvolve(reflect_pad(image, r), psf, 'same')[r:-r, r:-r]
 *
 * PSF (2r+1)^2 x 3 dihitung host dalam f64 (`precomputeDiffusionFilter`) dan
 * diunggah sebagai df64. Konvolusi: bidang FFT pangkat dua >= (h+2r, w+2r) --
 * pada ukuran itu konvolusi SIRKULAR identik dengan konvolusi linear untuk
 * wilayah tengah yang dipakai (tidak ada wrap yang terbaca). Dua kanal real
 * dikemas dalam satu FFT kompleks (R + iG, lalu B); kernel genap, jadi
 * spektrumnya real dan dua kernel juga muat dalam satu FFT kompleks. Spektrum
 * kernel di-cache per (family, ukuran piksel, dimensi): mengganti `strength`
 * hanya mengubah `p_s`, tidak memicu FFT kernel ulang.
 *
 * Presisi: seluruhnya df64 (lih. `fft.wgsl`) -- FFT f32 meleset 5e-5..3e-4
 * pada log10 di bayangan dalam di samping highlight.
 *
 * Frame harus utuh (tidak di-tile): radius sampai setengah sisi pendek, jadi
 * apron tile tidak masuk akal. `Session` menjaga ukuran render difusi agar
 * muat (`diffusionFftBytes`).
 */

export type DiffusionSite = 'camera' | 'print';

/** Setelan difusi satu situs untuk satu render (`FrameParams`). */
export type DiffusionFrame = DiffusionFilterConfig;

const PARAM_BYTES = 80;
const WORKGROUP = 256;
const MAX_GROUPS_X = 32768;

function nextPow2(n: number): number {
  let v = 1;
  while (v < n) v *= 2;
  return v;
}

/** Ukuran bidang FFT untuk citra `width x height` dengan radius `radius`. */
export function fftPlaneSize(width: number, height: number, radius: number): { nx: number; ny: number } {
  return { nx: nextPow2(width + 2 * radius), ny: nextPow2(height + 2 * radius) };
}

/** Radius kernel Python untuk citra ini (tanpa membangun PSF). */
export function diffusionRadiusPx(config: DiffusionFilterConfig, pixelSizeUm: number, width: number, height: number): number {
  return diffusionRadius(config, pixelSizeUm, Math.min(width, height));
}

/**
 * Byte GPU yang dibutuhkan satu situs difusi: tiga bidang kompleks df64
 * (data, ping-pong, spektrum kernel), 16 byte per elemen.
 */
export function diffusionFftBytes(width: number, height: number, radius: number): number {
  const { nx, ny } = fftPlaneSize(width, height, radius);
  return nx * ny * 16 * 3;
}

function df64(value: number): [number, number] {
  const hi = Math.fround(value);
  return [hi, Math.fround(value - hi)];
}

/** Twiddle exp(-2 pi i m / n), m < n/2, sebagai vec4 df64 (cos, sin). */
function twiddles(n: number): Float32Array {
  const out = new Float32Array((n / 2) * 4);
  for (let m = 0; m < n / 2; m += 1) {
    const angle = (-2 * Math.PI * m) / n;
    const [cHi, cLo] = df64(Math.cos(angle));
    const [sHi, sLo] = df64(Math.sin(angle));
    out.set([cHi, cLo, sHi, sLo], m * 4);
  }
  return out;
}

/** PSF dua kanal (a, b) -> vec4 df64 per piksel kernel; b = -1 berarti nol. */
function packKernel(filter: PrecomputedDiffusionFilter, a: number, b: number): Float32Array {
  const size = 2 * filter.radius + 1;
  const out = new Float32Array(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    const [aHi, aLo] = df64(filter.psf64[i * 3 + a]!);
    const [bHi, bLo] = b < 0 ? [0, 0] : df64(filter.psf64[i * 3 + b]!);
    out.set([aHi, aLo, bHi, bLo], i * 4);
  }
  return out;
}

interface Pipelines {
  fillImage: GPUComputePipeline;
  fillKernel: GPUComputePipeline;
  stockham: GPUComputePipeline;
  multiply: GPUComputePipeline;
  resolve: GPUComputePipeline;
}

const pipelineCache = new WeakMap<GPUDevice, Pipelines>();

function pipelinesFor(device: GPUDevice): Pipelines {
  let cached = pipelineCache.get(device);
  if (!cached) {
    const module = device.createShaderModule({ label: 'fft', code: source });
    const make = (entryPoint: string) =>
      device.createComputePipeline({ label: `fft:${entryPoint}`, layout: 'auto', compute: { module, entryPoint } });
    cached = {
      fillImage: make('fillImage'),
      fillKernel: make('fillKernel'),
      stockham: make('stockham'),
      multiply: make('multiply'),
      resolve: make('resolve'),
    };
    pipelineCache.set(device, cached);
  }
  return cached;
}

interface KernelCache {
  key: string;
  spectra: [GPUBuffer, GPUBuffer];
}

export function createDiffusionFftStage(device: GPUDevice, site: DiffusionSite, linearOutput = false): Stage {
  const pipelines = pipelinesFor(device);
  const twiddleCache = new Map<number, GPUBuffer>();
  let kernelCache: KernelCache | undefined;
  const filterMemo = new Map<string, PrecomputedDiffusionFilter>();
  const ownedBuffers = new Set<GPUBuffer>();

  function releaseFrameResources(): void {
    for (const buffer of ownedBuffers) buffer.destroy();
    ownedBuffers.clear();
    for (const buffer of twiddleCache.values()) buffer.destroy();
    twiddleCache.clear();
    kernelCache = undefined;
    filterMemo.clear();
  }

  function configOf(frame: Readonly<FrameParams>): DiffusionFrame {
    const config = site === 'camera' ? frame.cameraDiffusion : frame.printDiffusion;
    if (!config) throw new Error(`diffusion:${site}: FrameParams tidak membawa setelan difusi situs ini.`);
    return config;
  }

  function filterFor(config: DiffusionFrame, pixelSizeUm: number, width: number, height: number): PrecomputedDiffusionFilter {
    // PSF tidak bergantung pada strength (strength hanya menentukan p_s).
    const shapeKey = JSON.stringify({ ...config, strength: config.strength > 0 ? 1 : 0, pixelSizeUm, w: width, h: height });
    let filter = filterMemo.get(shapeKey);
    if (!filter) {
      filter = precomputeDiffusionFilter({ ...config, strength: Math.max(config.strength, 1e-6) }, pixelSizeUm, Math.min(width, height));
      filterMemo.clear();
      filterMemo.set(shapeKey, filter);
    }
    return filter;
  }

  function twiddleBuffer(ctx: StageContext, n: number): GPUBuffer {
    let buffer = twiddleCache.get(n);
    if (!buffer) {
      const data = twiddles(n);
      buffer = ctx.device.createBuffer({
        label: `fft:twiddles:${n}`,
        size: Math.max(data.byteLength, 16),
        usage: gpuBufferUsage.STORAGE,
        mappedAtCreation: true,
      });
      new Float32Array(buffer.getMappedRange()).set(data);
      buffer.unmap();
      twiddleCache.set(n, buffer);
    }
    return buffer;
  }

  return {
    name: `diffusion:${site}`,
    releaseFrameResources,
    dispose: releaseFrameResources,
    writesTaps: site === 'camera' ? [Tap.LOG_E_FILM] : [Tap.LOG_E_PRINT],
    spatialRadiusPx: 0,
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const { width, height, fullWidth, fullHeight } = ctx.params;
      if (width !== fullWidth || height !== fullHeight || ctx.params.activeWidth !== 0) {
        throw new Error(`diffusion:${site}: konvolusi FFT butuh frame utuh (tidak di-tile).`);
      }
      const config = configOf(ctx.frame);
      const pixelSizeUm = (ctx.frame.filmFormatMm * 1000) / Math.max(width, height, 1);
      const scatter =
        config.strength > 0 && (config.spatialScale ?? 1) > 0 ? strengthToScatter(config.strength, config.family) : 0;
      const filter = filterFor(config, pixelSizeUm, width, height);
      const radius = filter.radius;
      const { nx, ny } = fftPlaneSize(width, height, radius);
      const planeBytes = nx * ny * 16;
      const plane = ctx.scratch(`diffusion:${site}:plane`, planeBytes);
      const temp = ctx.scratch(`diffusion:${site}:temp`, planeBytes);
      const opaqueZero = 0;

      const writeParams = (fields: {
        radius?: number;
        n?: number;
        ns?: number;
        axis?: number;
        inverse?: number;
        chA?: number;
        chB?: number;
        scatter?: number;
        finalLog?: number;
        scale?: number;
        kernelSize?: number;
      }): GPUBuffer => {
        const buffer = ctx.device.createBuffer({
          label: `fft:params`,
          size: PARAM_BYTES,
          usage: gpuBufferUsage.UNIFORM,
          mappedAtCreation: true,
        });
        ownedBuffers.add(buffer);
        const range = buffer.getMappedRange();
        const u = new Uint32Array(range);
        const f = new Float32Array(range);
        u[0] = nx;
        u[1] = ny;
        u[2] = width;
        u[3] = height;
        u[4] = fields.radius ?? radius;
        u[5] = fields.n ?? 0;
        u[6] = fields.ns ?? 0;
        u[7] = fields.axis ?? 0;
        u[8] = fields.inverse ?? 0;
        u[9] = fields.chA ?? 0;
        u[10] = fields.chB ?? 4;
        u[11] = opaqueZero;
        f[12] = fields.scatter ?? 0;
        u[13] = fields.finalLog ?? 0;
        f[14] = fields.scale ?? 1;
        u[15] = fields.kernelSize ?? 1;
        // Match the shader's region-aware layout; whole-frame origin is zero.
        u[16] = width;
        u[17] = 0;
        u[18] = 0;
        buffer.unmap();
        return buffer;
      };

      const dispatch = (
        pipeline: GPUComputePipeline,
        threads: number,
        params: GPUBuffer,
        src: GPUBuffer,
        dst: GPUBuffer,
        aux: GPUBuffer,
      ): void => {
        const groups = Math.ceil(threads / WORKGROUP);
        const groupsX = Math.min(groups, MAX_GROUPS_X);
        const groupsY = Math.ceil(groups / groupsX);
        const bindGroup = ctx.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: src } },
            { binding: 1, resource: { buffer: dst } },
            { binding: 2, resource: { buffer: params } },
            { binding: 3, resource: { buffer: aux } },
          ].filter((e) => pipelineUses(pipeline, e.binding)),
        });
        const pass = encoder.beginComputePass({ label: `diffusion:${site}` });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(groupsX, groupsY, 1);
        pass.end();
      };

      // FFT 2D di tempat pada `buffers[0]` (ping-pong dengan `buffers[1]`).
      // Mengembalikan buffer yang memegang hasil.
      const fft2d = (data: GPUBuffer, scratchBuffer: GPUBuffer, inverse: boolean): GPUBuffer => {
        let src = data;
        let dst = scratchBuffer;
        for (const [axis, n] of [
          [0, nx],
          [1, ny],
        ] as const) {
          const tw = twiddleBuffer(ctx, n);
          for (let ns = 1; ns < n; ns *= 2) {
            dispatch(pipelines.stockham, (nx * ny) / 2, writeParams({ n, ns, axis, inverse: inverse ? 1 : 0 }), src, dst, tw);
            [src, dst] = [dst, src];
          }
        }
        return src;
      };

      // Spektrum kernel (dua pasang: RG dan B), di-cache per bentuk PSF.
      const kernelKey = `${nx}x${ny}|${radius}|${JSON.stringify({ ...config, strength: 0 })}|${pixelSizeUm}|${width}x${height}`;
      if (!kernelCache || kernelCache.key !== kernelKey) {
        kernelCache?.spectra.forEach((b) => { b.destroy(); ownedBuffers.delete(b); });
        const spectra: GPUBuffer[] = [];
        for (const [a, b] of [
          [0, 1],
          [2, -1],
        ] as const) {
          const packed = packKernel(filter, a, b);
          const psfBuffer = ctx.device.createBuffer({
            label: `diffusion:${site}:psf`,
            size: packed.byteLength,
            usage: gpuBufferUsage.STORAGE,
            mappedAtCreation: true,
          });
          ownedBuffers.add(psfBuffer);
          new Float32Array(psfBuffer.getMappedRange()).set(packed);
          psfBuffer.unmap();
          const spectrum = ctx.device.createBuffer({
            label: `diffusion:${site}:kernelSpectrum`,
            size: planeBytes,
            usage: gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_DST | gpuBufferUsage.COPY_SRC,
          });
          ownedBuffers.add(spectrum);
          dispatch(pipelines.fillKernel, nx * ny, writeParams({ kernelSize: 2 * radius + 1 }), psfBuffer, spectrum, psfBuffer);
          const result = fft2d(spectrum, temp, false);
          if (result !== spectrum) encoder.copyBufferToBuffer(result, 0, spectrum, 0, planeBytes);
          spectra.push(spectrum);
        }
        kernelCache = { key: kernelKey, spectra: [spectra[0]!, spectra[1]!] };
      }

      const scale = 1 / (nx * ny);
      const finalLog = site === 'print' && !linearOutput ? 1 : 0;
      for (const [pairIndex, [a, b]] of (
        [
          [0, 1],
          [2, 4],
        ] as const
      ).entries()) {
        dispatch(pipelines.fillImage, nx * ny, writeParams({ chA: a, chB: b }), ctx.source, plane, ctx.source);
        const spectrum = fft2d(plane, temp, false);
        const other = spectrum === plane ? temp : plane;
        dispatch(pipelines.multiply, nx * ny, writeParams({}), spectrum, other, kernelCache.spectra[pairIndex]!);
        const other2 = other === plane ? temp : plane;
        const conv = fft2d(other, other2, true);
        dispatch(pipelines.resolve, width * height, writeParams({ chA: a, chB: b, scatter, finalLog, scale }), conv, ctx.dest, ctx.source);
      }
    },
  };
}

/** Binding yang dipakai tiap entry point (`layout: 'auto'` membuang yang tak terjangkau). */
function pipelineUses(pipeline: GPUComputePipeline, binding: number): boolean {
  const label = pipeline.label;
  if (label === 'fft:fillImage' || label === 'fft:fillKernel') return binding !== 3;
  return true;
}
