import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireDevice } from '../../src/engine/device';
import type { EngineDevice } from '../../src/engine/device';
import { GaussianBlur, SMALL_SIGMA_MAX, gaussianKernel1d, yvvCoefficients } from '../../src/engine/gaussian';
import { gpuBufferUsage, gpuMapMode } from '../../src/engine/webgpuGlobals';
import { readF32 } from '../readF32';

/**
 * Gerbang primitif `GaussianBlur` (Fase 2A.5 Task 2) terhadap
 * `fast_gaussian_filter`/`fast_exponential_filter` hulu
 * (`tools/gen_gaussian_reference.py`). Primitif ini dipakai halation dan DIR
 * di rezim resolusi produksi; menggerbanginya sendiri memisahkan galat blur
 * dari galat tahap.
 */

const DIR = join('test', 'fixtures', 'gaussian');
const TOLERANCE = 1e-6;

interface GaussianCase {
  name: string;
  kind: 'gaussian' | 'exponential';
  sigma: [number, number, number];
  truncate: number;
  width: number;
  height: number;
}

describe('koefisien host', () => {
  it('yvvCoefficients mengikuti rumus hulu dan berjumlah 1', () => {
    const [B, b1, b2, b3] = yvvCoefficients(5);
    const q = 0.98711 * 5 - 0.9633;
    const b0 = 1.57825 + 2.44413 * q + 1.4281 * q * q + 0.422205 * q ** 3;
    expect(b1).toBeCloseTo((2.44413 * q + 2.85619 * q * q + 1.26661 * q ** 3) / b0, 12);
    expect(B + b1 + b2 + b3).toBeCloseTo(1, 12);
  });

  it('yvvCoefficients memakai cabang sigma < 2.5', () => {
    const [, b1] = yvvCoefficients(2);
    const q = 3.97156 - 4.14554 * Math.sqrt(1 - 0.26891 * 2);
    const b0 = 1.57825 + 2.44413 * q + 1.4281 * q * q + 0.422205 * q ** 3;
    expect(b1).toBeCloseTo((2.44413 * q + 2.85619 * q * q + 1.26661 * q ** 3) / b0, 12);
  });

  it('gaussianKernel1d: radius int(truncate*sigma + 0.5), ternormalisasi', () => {
    const { weights, radius } = gaussianKernel1d(1.2, 3);
    expect(radius).toBe(4);
    expect(weights.length).toBe(9);
    expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 14);
    expect(gaussianKernel1d(1e-6, 3).radius).toBe(0);
  });

  it('ambang IIR adalah 3 px', () => {
    expect(SMALL_SIGMA_MAX).toBe(3);
  });
});

let engine: EngineDevice;
let blur: GaussianBlur;

beforeAll(async () => {
  engine = await acquireDevice();
  blur = new GaussianBlur(engine.device);
});

function rgbToRgba(rgb: Float32Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array((rgb.length / 3) * 4);
  for (let p = 0; p < rgb.length / 3; p += 1) out.set([rgb[p * 3]!, rgb[p * 3 + 1]!, rgb[p * 3 + 2]!, 1], p * 4);
  return out;
}

async function runBlur(c: GaussianCase, input: Float32Array): Promise<Float32Array> {
  const device = engine.device;
  const bytes = c.width * c.height * 16;
  const usage = gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_SRC | gpuBufferUsage.COPY_DST;
  const src = device.createBuffer({ size: bytes, usage });
  const dst = device.createBuffer({ size: bytes, usage });
  const scratch = device.createBuffer({ size: bytes, usage });
  const component = device.createBuffer({ size: bytes, usage });
  const read = device.createBuffer({ size: bytes, usage: gpuBufferUsage.MAP_READ | gpuBufferUsage.COPY_DST });
  device.queue.writeBuffer(src, 0, rgbToRgba(input) as Float32Array<ArrayBuffer>);
  const encoder = device.createCommandEncoder();
  const common = {
    src,
    dst,
    scratch,
    bufferWidth: c.width,
    bufferHeight: c.height,
    rect: { x: 0, y: 0, width: c.width, height: c.height },
    truncate: c.truncate,
  };
  if (c.kind === 'gaussian') blur.encode(encoder, { ...common, sigma: c.sigma });
  else blur.encodeExponential(encoder, { ...common, component, decay: c.sigma });
  encoder.copyBufferToBuffer(dst, 0, read, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await read.mapAsync(gpuMapMode.READ);
  const out = new Float32Array(read.getMappedRange().slice(0));
  read.unmap();
  for (const b of [src, dst, scratch, component, read]) b.destroy();
  return out;
}

describe('parity: GaussianBlur vs fast_gaussian_filter', () => {
  for (const name of ['zero', 'small', 'threshold', 'large', 'mixed', 'narrow', 'exponential']) {
    it(name, async () => {
      const c = JSON.parse(readFileSync(join(DIR, name, 'case.json'), 'utf8')) as GaussianCase;
      const input = readF32(join(DIR, name, 'input.f32'));
      const expected = readF32(join(DIR, name, 'output.f32'));
      const actual = await runBlur(c, input);
      let maxAbs = 0;
      for (let p = 0; p < c.width * c.height; p += 1) {
        for (let ch = 0; ch < 3; ch += 1) {
          maxAbs = Math.max(maxAbs, Math.abs(actual[p * 4 + ch]! - expected[p * 3 + ch]!));
        }
        expect(actual[p * 4 + 3]).toBe(1); // alpha disalin apa adanya
      }
      if (name === 'zero') expect(maxAbs).toBe(0);
      expect(maxAbs, `${name}: max abs ${maxAbs.toExponential(3)}`).toBeLessThanOrEqual(TOLERANCE);
    });
  }
});
