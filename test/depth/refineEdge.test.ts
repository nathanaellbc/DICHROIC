import { describe, expect, it } from 'vitest';
import { MATTE_TILE, bandBounds, bandInCrop, buildTrimap, computeMatte, edgeThreshold, layeredDepth, shaderMatte } from '../../src/depth/refineEdge';
import type { DepthMap } from '../../src/host/lens';

// Subjek dekat di kiri (d = 1), latar jauh di kanan (d = 0); sapuan vertikal di tepi x = 0,5.
function scene() {
  const depth: DepthMap = { width: 64, height: 48, data: new Float32Array(64 * 48) };
  for (let y = 0; y < 48; y += 1) for (let x = 0; x < 64; x += 1) depth.data[y * 64 + x] = x < 32 ? 1 : 0;
  const mask = { width: 200, height: 150, data: new Uint8Array(200 * 150) };
  for (let y = 30; y < 120; y += 1) for (let x = 90; x < 110; x += 1) mask.data[y * 200 + x] = 1;
  return { depth, mask };
}

describe('Refine Edge', () => {
  it('kotak sapuan, pita di potongan, ambang, dan trimap', () => {
    const { depth, mask } = scene();
    const rect = bandBounds(mask, 0)!;
    expect(rect.x).toBeCloseTo(0.45, 6);
    expect(rect.w).toBeCloseTo(0.1, 6);
    expect(rect.y).toBeCloseTo(0.2, 6);
    const padded = bandBounds(mask)!;
    expect(padded.x).toBeLessThan(rect.x);
    const W = 80, H = 120;
    const band = bandInCrop(mask, padded, W, H);
    const t = edgeThreshold(depth, padded, W, H);
    expect(t).toBeGreaterThan(0.2);
    expect(t).toBeLessThan(0.8);
    const tri = buildTrimap(depth, padded, band, W, H, t);
    const row = 60 * W;
    expect(tri[row]).toBe(255); // tepi kiri potongan: subjek
    expect(tri[row + W - 1]).toBe(0); // tepi kanan: latar
    expect(tri[row + W / 2]).toBe(128); // tengah pita: ragu
  });

  it('ViTMatte hanya di tile berpita, tumpang-tindih dicampur, piksel pasti dari trimap', async () => {
    const W = MATTE_TILE + 300, H = 200;
    const rgba = new Uint8ClampedArray(W * H * 4);
    const tri = new Uint8Array(W * H).fill(255);
    for (let y = 0; y < H; y += 1) for (let x = W - 100; x < W; x += 1) tri[y * W + x] = x < W - 50 ? 128 : 0;
    const calls: Array<[number, number]> = [];
    const alpha = await computeMatte(rgba, tri, W, H, async (input, tw, th) => {
      expect(tw % 32).toBe(0);
      expect(th % 32).toBe(0);
      // Kanal ke-4 = trimap/255: piksel pertama tile kanan masih subjek pasti.
      expect(input[3 * tw * th]).toBe(1);
      calls.push([tw, th]);
      return new Float32Array(tw * th).fill(0.25);
    });
    // Dua tile horizontal (0 dan W-512); hanya yang memuat pita (kanan) dijalankan.
    expect(calls).toHaveLength(1);
    expect(alpha[0]).toBe(1);
    expect(alpha[100 * W + W - 75]).toBeCloseTo(0.25, 6);
    expect(alpha[100 * W + W - 1]).toBe(0);
  });

  it('matte shader: alfa di pita, 1 di luar; lapis hanya berubah di sekitar pita', () => {
    const { depth, mask } = scene();
    const rect = bandBounds(mask)!;
    const W = 80, H = 120;
    const band = bandInCrop(mask, rect, W, H);
    const alpha = new Float32Array(W * H).fill(0.4);
    const matte = shaderMatte(rect, alpha, band, W, H);
    expect(matte.alpha[0]).toBe(1);
    expect(matte.alpha[60 * W + W / 2]).toBeCloseTo(0.4, 6);
    const { foreground, background } = layeredDepth(depth, matte, 0.5);
    // Jauh dari pita: identik dengan peta.
    expect(foreground[2 * 64 + 2]).toBe(depth.data[2 * 64 + 2]);
    expect(background[40 * 64 + 60]).toBe(depth.data[40 * 64 + 60]);
    // Di pita (sisi latar): lapis depan = kedalaman subjek, belakang = latar.
    const i = 24 * 64 + 33;
    expect(foreground[i]).toBeCloseTo(1, 6);
    expect(background[i]).toBeCloseTo(0, 6);
  });
});
