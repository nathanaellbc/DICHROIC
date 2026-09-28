/**
 * `GaussianBlur` -- primitif blur bersama Fase 2A.5, port
 * `utils/fast_gaussian_filter.py` spektrafilm (lih. `src/shaders/gaussian.wgsl`).
 *
 * Kenapa ada: seluruh blur spasial hulu memakai `fast_gaussian_filter`, yang
 * beralih dari FIR ke IIR Young-van Vliet pada sigma >= 3 px. Fase 1 hanya
 * mem-port jalur FIR karena semua fixture berukuran piksel ~550 um (sigma
 * < 3); di foto sungguhan (~6 um/px) halation dan DIR jauh di atas ambang
 * itu. Primitif ini digerbangi langsung terhadap hulu
 * (`test/parity/gaussian.test.ts`, `tools/gen_gaussian_reference.py`).
 *
 * Koefisien dan kernel dihitung di host dalam f64 (seperti numba hulu) lalu
 * diunggah sebagai f32; hanya aritmetika per piksel yang f32.
 */

import source from '../shaders/gaussian.wgsl?raw';
import { gpuBufferUsage } from './webgpuGlobals';

export const SMALL_SIGMA_MAX = 3;
const MAX_RADIUS = 32;
const STRIDE = 2 * MAX_RADIUS + 1;
const PARAMS_BYTES = 192;

const OP_COPY = 0;
const OP_FIR_V = 1;
const OP_FIR_H = 2;
const OP_IIR_H = 3;
const OP_IIR_V = 4;
const OP_SCALE_ADD = 5;

/** `_EXPONENTIAL_GAUSSIAN_FITS[3]` hulu: (amplitudo, sigma/lambda). */
export const EXPONENTIAL_FIT_3: ReadonlyArray<readonly [number, number]> = [
  [0.1633, 0.536],
  [0.6496, 1.5236],
  [0.187, 2.7684],
];

export type Vec3 = [number, number, number];

export interface BlurRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BlurArgs {
  src: GPUBuffer;
  dst: GPUBuffer;
  scratch: GPUBuffer;
  bufferWidth: number;
  bufferHeight: number;
  rect: BlurRect;
  sigma: Vec3;
  /** Default 3.0, bawaan `fast_gaussian_filter`. */
  truncate?: number;
}

export interface ExponentialArgs extends Omit<BlurArgs, 'sigma'> {
  /** Buffer untuk tiap komponen Gaussian sebelum dijumlahkan ke `dst`. */
  component: GPUBuffer;
  /** Konstanta peluruhan lambda per kanal, dalam piksel. */
  decay: Vec3;
}

/**
 * Rektangel data SAH untuk blur di satu tahap: active rect tahap itu (lih.
 * `CoreParams.active*`; 0 = seluruh buffer) digelembungkan `radius` px dan
 * diklip ke buffer. Di bawah tiling dengan apron menyusut (`RenderGraph`
 * `shrinkApron`), di luar rect ini buffer bisa berisi data basi dari tahap
 * sebelumnya; rekursi IIR membaca satu baris penuh, jadi batasnya WAJIB rect
 * ini, bukan buffer. Untuk render full-frame hasilnya seluruh buffer.
 */
export function validInputRect(
  params: {
    width: number;
    height: number;
    activeOriginX: number;
    activeOriginY: number;
    activeWidth: number;
    activeHeight: number;
  },
  radius: number,
): BlurRect {
  if (params.activeWidth === 0 || params.activeHeight === 0) {
    return { x: 0, y: 0, width: params.width, height: params.height };
  }
  const x0 = Math.max(0, params.activeOriginX - radius);
  const y0 = Math.max(0, params.activeOriginY - radius);
  const x1 = Math.min(params.width, params.activeOriginX + params.activeWidth + radius);
  const y1 = Math.min(params.height, params.activeOriginY + params.activeHeight + radius);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Port `_yvv_coeffs`: [B, b1/b0, b2/b0, b3/b0]. */
export function yvvCoefficients(sigma: number): [number, number, number, number] {
  const q = sigma >= 2.5 ? 0.98711 * sigma - 0.9633 : 3.97156 - 4.14554 * Math.sqrt(1 - 0.26891 * sigma);
  const q2 = q * q;
  const q3 = q2 * q;
  const b0 = 1.57825 + 2.44413 * q + 1.4281 * q2 + 0.422205 * q3;
  const b1 = 2.44413 * q + 2.85619 * q2 + 1.26661 * q3;
  const b2 = -(1.4281 * q2 + 1.26661 * q3);
  const b3 = 0.422205 * q3;
  const B = 1 - (b1 + b2 + b3) / b0;
  return [B, b1 / b0, b2 / b0, b3 / b0];
}

/** Port `_gaussian_kernel_1d`: radius `int(truncate*sigma + 0.5)`, bobot ternormalisasi. */
export function gaussianKernel1d(sigma: number, truncate: number): { weights: Float64Array; radius: number } {
  const radius = Math.trunc(truncate * sigma + 0.5);
  const weights = new Float64Array(2 * radius + 1);
  let total = 0;
  for (let i = 0; i < weights.length; i += 1) {
    const x = i - radius;
    const v = Math.exp(-0.5 * (x / sigma) ** 2);
    weights[i] = v;
    total += v;
  }
  for (let i = 0; i < weights.length; i += 1) weights[i]! /= total;
  return { weights, radius };
}

type Path = 'copy' | 'fir' | 'iir';

function pathFor(sigma: number): Path {
  if (!(sigma > 0)) return 'copy';
  return sigma >= SMALL_SIGMA_MAX ? 'iir' : 'fir';
}

const shared = new WeakMap<GPUDevice, GaussianBlur>();

export class GaussianBlur {
  private readonly pipeline: GPUComputePipeline;

  /**
   * Satu instance per device: kompilasi shader df64 ini mahal (terukur ~1-3 s
   * di Dawn/D3D12), dan halation/DIR membangun tahapnya ulang per rantai.
   * Instance tidak menyimpan keadaan per render, jadi aman dibagi.
   */
  static shared(device: GPUDevice): GaussianBlur {
    let blur = shared.get(device);
    if (!blur) {
      blur = new GaussianBlur(device);
      shared.set(device, blur);
    }
    return blur;
  }

  constructor(private readonly device: GPUDevice) {
    const module = device.createShaderModule({ label: 'gaussian', code: source });
    this.pipeline = device.createComputePipeline({
      label: 'gaussian',
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    });
  }

  /** Blur per kanal `src` -> `dst` di dalam `rect`; alpha dan kanal sigma 0 disalin apa adanya. */
  encode(encoder: GPUCommandEncoder, args: BlurArgs): void {
    const truncate = args.truncate ?? 3;
    const paths = args.sigma.map(pathFor) as [Path, Path, Path];
    const radius: Vec3 = [0, 0, 0];
    const kernels = new Float32Array(3 * STRIDE);
    const iir = { B: [0, 0, 0], b1: [0, 0, 0], b2: [0, 0, 0], b3: [0, 0, 0] };
    let firMask = 0;
    let iirMask = 0;
    for (let c = 0; c < 3; c += 1) {
      const sigma = args.sigma[c]!;
      if (paths[c] === 'fir') {
        const k = gaussianKernel1d(sigma, truncate);
        if (k.radius > MAX_RADIUS) {
          throw new RangeError(`GaussianBlur: radius FIR ${k.radius} > ${MAX_RADIUS} (truncate ${truncate} terlalu besar).`);
        }
        radius[c] = k.radius;
        for (let i = 0; i < k.weights.length; i += 1) kernels[c * STRIDE + MAX_RADIUS - k.radius + i] = k.weights[i]!;
        firMask |= 1 << c;
      } else if (paths[c] === 'iir') {
        const [B, b1, b2, b3] = yvvCoefficients(sigma);
        iir.B[c] = B;
        iir.b1[c] = b1;
        iir.b2[c] = b2;
        iir.b3[c] = b3;
        iirMask |= 1 << c;
      }
    }

    const weights = this.device.createBuffer({
      label: 'gaussian:weights',
      size: kernels.byteLength,
      usage: gpuBufferUsage.STORAGE,
      mappedAtCreation: true,
    });
    new Float32Array(weights.getMappedRange()).set(kernels);
    weights.unmap();

    const base = { args, weights, radius, iir };
    this.pass(encoder, { ...base, op: OP_COPY, mask: 0b111, src: args.src, dst: args.dst });
    if (firMask) {
      this.pass(encoder, { ...base, op: OP_FIR_V, mask: firMask, src: args.src, dst: args.dst });
      this.pass(encoder, { ...base, op: OP_FIR_H, mask: firMask, src: args.src, dst: args.dst });
    }
    if (iirMask) {
      this.pass(encoder, { ...base, op: OP_IIR_H, mask: iirMask, src: args.src, dst: args.dst });
      this.pass(encoder, { ...base, op: OP_IIR_V, mask: iirMask, src: args.src, dst: args.dst });
    }
  }

  /** `dst = (first ? 0 : dst) + amplitude * src` (rgb); alpha dari `src`. */
  encodeScaleAdd(
    encoder: GPUCommandEncoder,
    args: Omit<BlurArgs, 'sigma' | 'truncate'> & { amplitude: number; first: boolean },
  ): void {
    this.pass(encoder, {
      args: { ...args, sigma: [0, 0, 0] },
      weights: undefined,
      radius: [0, 0, 0],
      iir: { B: [0, 0, 0], b1: [0, 0, 0], b2: [0, 0, 0], b3: [0, 0, 0] },
      op: OP_SCALE_ADD,
      mask: 0b111,
      src: args.src,
      dst: args.dst,
      amplitude: args.amplitude,
      first: args.first,
    });
  }

  /**
   * Port `fast_exponential_filter(n_gaussians=3)`: `Σ a_k · G(src, r_k·λ)`,
   * dijumlahkan berurutan seperti hulu (`result = a0*c0; result += ...`).
   */
  encodeExponential(encoder: GPUCommandEncoder, args: ExponentialArgs): void {
    EXPONENTIAL_FIT_3.forEach(([amplitude, ratio], k) => {
      const sigma = args.decay.map((l) => ratio * l) as Vec3;
      this.encode(encoder, { ...args, dst: args.component, sigma });
      this.pass(encoder, {
        args: { ...args, sigma },
        weights: undefined,
        radius: [0, 0, 0],
        iir: { B: [0, 0, 0], b1: [0, 0, 0], b2: [0, 0, 0], b3: [0, 0, 0] },
        op: OP_SCALE_ADD,
        mask: 0b111,
        src: args.component,
        dst: args.dst,
        amplitude,
        first: k === 0,
      });
    });
  }

  private pass(
    encoder: GPUCommandEncoder,
    o: {
      args: BlurArgs | ExponentialArgs;
      weights: GPUBuffer | undefined;
      radius: Vec3;
      iir: { B: number[]; b1: number[]; b2: number[]; b3: number[] };
      op: number;
      mask: number;
      src: GPUBuffer;
      dst: GPUBuffer;
      amplitude?: number;
      first?: boolean;
    },
  ): void {
    const { rect } = o.args;
    const staging = new ArrayBuffer(PARAMS_BYTES);
    const u32 = new Uint32Array(staging);
    const f32 = new Float32Array(staging);
    u32.set([o.args.bufferWidth, o.args.bufferHeight, rect.x, rect.y, rect.width, rect.height, o.op, o.mask]);
    u32.set([o.radius[0], o.radius[1], o.radius[2], 0], 8);
    // df64: hi = f32 terdekat, lo = sisa f64 yang dibulatkan ke f32.
    const hi = (v: number[]) => v.map((x) => Math.fround(x));
    const lo = (v: number[]) => v.map((x) => Math.fround(x - Math.fround(x)));
    f32.set([...hi(o.iir.B), 0], 12);
    f32.set([...hi(o.iir.b1), 0], 16);
    f32.set([...hi(o.iir.b2), 0], 20);
    f32.set([...hi(o.iir.b3), 0], 24);
    f32.set([...lo(o.iir.B), 0], 28);
    f32.set([...lo(o.iir.b1), 0], 32);
    f32.set([...lo(o.iir.b2), 0], 36);
    f32.set([...lo(o.iir.b3), 0], 40);
    f32[44] = o.amplitude ?? 0;
    u32[45] = o.first ? 1 : 0;

    const params = this.device.createBuffer({
      label: `gaussian:params:${o.op}`,
      size: PARAMS_BYTES,
      usage: gpuBufferUsage.UNIFORM,
      mappedAtCreation: true,
    });
    new Uint8Array(params.getMappedRange()).set(new Uint8Array(staging));
    params.unmap();

    const weights =
      o.weights ??
      this.device.createBuffer({ label: 'gaussian:weights:none', size: STRIDE * 3 * 4, usage: gpuBufferUsage.STORAGE });

    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: o.src } },
        { binding: 1, resource: { buffer: o.dst } },
        { binding: 2, resource: { buffer: o.args.scratch } },
        { binding: 3, resource: { buffer: params } },
        { binding: 4, resource: { buffer: weights } },
      ],
    });
    const pass = encoder.beginComputePass({ label: `gaussian:${o.op}` });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    if (o.op === OP_IIR_H) pass.dispatchWorkgroups(Math.ceil(rect.height / 64), 1, 1);
    else if (o.op === OP_IIR_V) pass.dispatchWorkgroups(Math.ceil(rect.width / 64), 1, 1);
    else pass.dispatchWorkgroups(Math.ceil(rect.width / 64), rect.height, 1);
    pass.end();
  }
}
