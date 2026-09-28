import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import { loadAssets } from '../src/profiles/load';
import type { AssetBundle } from '../src/profiles/load';
import { measureAutoExposureEv } from '../src/host/autoExposure';

/**
 * Auto-exposure `center_weighted` (port `measureAutoExposureEv` OFX). Gerbang
 * parity-nya yang sebenarnya tetap `filmExposure.test.ts`/`measuredChain.test.ts`
 * (rasio `rgb_pre/input` Python); berkas ini mengunci sifat aritmetikanya
 * sendiri -- terutama jalur preview > 256 px, yang TIDAK PERNAH disentuh
 * fixture (semuanya <= 64 px) tapi PASTI disentuh setiap foto sungguhan.
 */

let bundle: AssetBundle;
let meter: ArrayLike<number>;
let cs: number;

beforeAll(async () => {
  bundle = await loadAssets(join('public', 'data'));
  meter = bundle.staticTable('inputMeterXyzMatrices');
  cs = bundle.manifest.colorSpaces.labels.indexOf('ProPhoto RGB');
});

/** Gambar netral seragam yang Y terukurnya persis `y`. */
function uniformWithY(y: number, width: number, height: number): Float32Array {
  const o = cs * 9;
  const k = y / (meter[o + 3]! + meter[o + 4]! + meter[o + 5]!);
  const rgba = new Float32Array(width * height * 4);
  for (let p = 0; p < width * height; p += 1) rgba.set([k, k, k, 1], p * 4);
  return rgba;
}

describe('measureAutoExposureEv', () => {
  it('memberi 0 EV untuk abu-abu tengah 0.184', () => {
    expect(measureAutoExposureEv(uniformWithY(0.184, 32, 16), 32, 16, meter, cs)).toBeCloseTo(0, 6);
  });

  it('memberi -1 EV untuk dua kali abu-abu tengah dan +1 EV untuk separuhnya', () => {
    expect(measureAutoExposureEv(uniformWithY(0.368, 32, 16), 32, 16, meter, cs)).toBeCloseTo(-1, 6);
    expect(measureAutoExposureEv(uniformWithY(0.092, 32, 16), 32, 16, meter, cs)).toBeCloseTo(1, 6);
  });

  it('memberi 0 untuk gambar tanpa piksel dan untuk gambar hitam penuh', () => {
    expect(measureAutoExposureEv(new Float32Array(0), 0, 0, meter, cs)).toBe(0);
    expect(measureAutoExposureEv(new Float32Array(32 * 16 * 4), 32, 16, meter, cs)).toBe(0);
  });

  it('jalur preview > 256 px memberi EV yang sama untuk gambar seragam', () => {
    const big = measureAutoExposureEv(uniformWithY(0.25, 512, 300), 512, 300, meter, cs);
    const small = measureAutoExposureEv(uniformWithY(0.25, 64, 37), 64, 37, meter, cs);
    expect(big).toBeCloseTo(small, 6);
    expect(big).toBeCloseTo(-Math.log2(0.25 / 0.184), 6);
  });
});
