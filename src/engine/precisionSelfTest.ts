/**
 * Self-test presisi IIR (Fase 2A.5, temuan review akhir). Rekursi Young-van
 * Vliet di `gaussian.wgsl` memakai df64 (two-sum/two-prod Dekker) karena f32
 * polos meleset hingga 1.6e-3 dari hulu. df64 bergantung pada compiler shader
 * yang TIDAK melakukan reasosiasi fast-math; backend yang melakukannya
 * meruntuhkannya ke presisi f32 tanpa galat apa pun -- gambar salah secara
 * diam-diam. Self-test ini menjalankan satu blur kecil di GPU dan
 * membandingkannya dengan referensi CPU f64 (`gaussianReference.ts`, yang
 * digerbangi terhadap Python), supaya `Session` bisa melaporkannya ke UI.
 */

import { GaussianBlur } from './gaussian';
import type { Vec3 } from './gaussian';
import { gaussianFilterCpu } from './gaussianReference';
import { gpuBufferUsage, gpuMapMode } from './webgpuGlobals';

/** Di atas derau df64 (<= 2.4e-7 terukur), di bawah keruntuhan ke f32 (>= 1e-4). */
export const SELF_TEST_TOLERANCE = 1e-5;

const WIDTH = 48;
const HEIGHT = 32;
const SIGMA: Vec3 = [2, 9, 25]; // FIR, IIR sedang, IIR besar (koefisien paling rawan)

export interface SelfTestResult {
  ok: boolean;
  maxAbsError: number;
}

export function compareSelfTest(gpuRgb: ArrayLike<number>, cpuRgb: ArrayLike<number>): SelfTestResult {
  let maxAbsError = 0;
  for (let i = 0; i < cpuRgb.length; i += 1) maxAbsError = Math.max(maxAbsError, Math.abs(gpuRgb[i]! - cpuRgb[i]!));
  return { ok: maxAbsError <= SELF_TEST_TOLERANCE, maxAbsError };
}

export async function runPrecisionSelfTest(device: GPUDevice): Promise<SelfTestResult> {
  // Input deterministik (LCG), dibulatkan f32 agar CPU dan GPU melihat nilai yang sama.
  const rgb = new Float32Array(WIDTH * HEIGHT * 3);
  let state = 12345;
  for (let i = 0; i < rgb.length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    rgb[i] = (state >>> 8) / 16777216;
  }
  const rgba = new Float32Array(WIDTH * HEIGHT * 4);
  for (let p = 0; p < WIDTH * HEIGHT; p += 1) rgba.set([rgb[p * 3]!, rgb[p * 3 + 1]!, rgb[p * 3 + 2]!, 1], p * 4);

  const bytes = rgba.byteLength;
  const usage = gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_SRC | gpuBufferUsage.COPY_DST;
  const src = device.createBuffer({ label: 'selfTest:src', size: bytes, usage });
  const dst = device.createBuffer({ label: 'selfTest:dst', size: bytes, usage });
  const scratch = device.createBuffer({ label: 'selfTest:scratch', size: bytes, usage });
  const read = device.createBuffer({
    label: 'selfTest:read',
    size: bytes,
    usage: gpuBufferUsage.MAP_READ | gpuBufferUsage.COPY_DST,
  });
  try {
    device.queue.writeBuffer(src, 0, rgba);
    const encoder = device.createCommandEncoder({ label: 'selfTest' });
    GaussianBlur.shared(device).encode(encoder, {
      src,
      dst,
      scratch,
      bufferWidth: WIDTH,
      bufferHeight: HEIGHT,
      rect: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      sigma: SIGMA,
    });
    encoder.copyBufferToBuffer(dst, 0, read, 0, bytes);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(gpuMapMode.READ);
    const out = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    const gpuRgb = new Float32Array(WIDTH * HEIGHT * 3);
    for (let p = 0; p < WIDTH * HEIGHT; p += 1) gpuRgb.set([out[p * 4]!, out[p * 4 + 1]!, out[p * 4 + 2]!], p * 3);
    return compareSelfTest(gpuRgb, gaussianFilterCpu(rgb, WIDTH, HEIGHT, SIGMA));
  } finally {
    for (const b of [src, dst, scratch, read]) b.destroy();
  }
}
