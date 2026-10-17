import { describe, expect, it } from 'vitest';
import { MATTE_TILE, bandBounds, bandInCrop, buildTrimap, computeMatte, distanceToBandEdge, edgeThreshold, featherBandEdge, layeredDepth, shaderMatte } from '../../src/depth/refineEdge';
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

  it('matte shader: alfa di pita, trimap di luar (sisi latar 0); lapis hanya berubah di sekitar pita', () => {
    const { depth, mask } = scene();
    const rect = bandBounds(mask)!;
    const W = 80, H = 120;
    const band = bandInCrop(mask, rect, W, H);
    const alpha = new Float32Array(W * H).fill(0.4);
    const trimap = new Uint8Array(W * H).fill(255);
    trimap[W - 1] = 0; // satu piksel sisi latar di luar pita
    const matte = shaderMatte(rect, alpha, band, trimap, W, H);
    expect(matte.alpha[0]).toBe(1);
    expect(matte.alpha[W - 1]).toBe(0);
    expect(matte.alpha[60 * W + W / 2]).toBeCloseTo(0.4, 6);
    const { foreground, background } = layeredDepth(depth, rect, band, W, H, 0.5);
    // Jauh dari pita: identik dengan peta.
    expect(foreground[2 * 64 + 2]).toBe(depth.data[2 * 64 + 2]);
    expect(background[40 * 64 + 60]).toBe(depth.data[40 * 64 + 60]);
    // Di pita (sisi latar): lapis depan = kedalaman subjek, belakang = latar.
    const i = 24 * 64 + 33;
    expect(foreground[i]).toBeCloseTo(1, 6);
    expect(background[i]).toBeCloseTo(0, 6);
  });

  it('helai pasti subjek (alfa 1) dan helai jauh dari tubuh di peta kedalaman tetap memakai kedalaman subjek', () => {
    // Peta kedalaman: subjek hanya x < 10 (d = 0,8); pita sapuan x = 10..60 (rambut mencuat jauh).
    const depth: DepthMap = { width: 64, height: 48, data: new Float32Array(64 * 48) };
    for (let y = 0; y < 48; y += 1) for (let x = 0; x < 64; x += 1) depth.data[y * 64 + x] = x < 10 ? 0.8 : 0.1;
    const rect = { x: 0, y: 0, w: 1, h: 1 };
    const W = 64, H = 48;
    const band = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 1) for (let x = 10; x < 60; x += 1) band[y * W + x] = 1;
    const { foreground, background } = layeredDepth(depth, rect, band, W, H, 0.45);
    for (const x of [12, 40, 58]) {
      expect(foreground[24 * 64 + x], `x=${x}`).toBeCloseTo(0.8, 6);
      expect(background[24 * 64 + x], `x=${x}`).toBeCloseTo(0.1, 6);
    }
    // Di luar pita: tidak berubah.
    expect(foreground[24 * 64 + 62]).toBeCloseTo(0.1, 6);
  });

  it('tepi pita beralih ke satu lapis: alfa 1 dan lapis = kedalaman di tepi, penuh di dalam', () => {
    // Pita x = 10..49 pada baris 20 px; kedalaman: kiri subjek (0,8), kanan latar (0,1).
    const W = 60, H = 20;
    const band = new Uint8Array(W * H);
    for (let y = 0; y < H; y += 1) for (let x = 10; x < 50; x += 1) band[y * W + x] = 1;
    const dist = distanceToBandEdge(band, W, H);
    expect(dist[10 * W + 10]).toBeCloseTo(1, 6);
    expect(dist[10 * W + 30]).toBeGreaterThan(9);
    const alpha = new Float32Array(W * H).fill(0);
    featherBandEdge(alpha, band, W, H, 6);
    expect(alpha[10 * W + 5]).toBe(0); // di luar pita: tidak disentuh
    expect(alpha[10 * W + 10]).toBeGreaterThan(0.9); // tepi: hampir satu lapis
    expect(alpha[10 * W + 30]).toBe(0); // dalam: alfa ViTMatte
    const depth: DepthMap = { width: W, height: H, data: new Float32Array(W * H) };
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) depth.data[y * W + x] = x < 30 ? 0.8 : 0.1;
    const rect = { x: 0, y: 0, w: 1, h: 1 };
    const soft = layeredDepth(depth, rect, band, W, H, 0.45, 6);
    // Tepi pita (texel 9 sudah menyentuh pita): kedua lapis = kedalaman sendiri.
    expect(soft.foreground[10 * W + 9]).toBeCloseTo(0.8, 6);
    expect(soft.background[10 * W + 9]).toBeGreaterThan(0.7); // bobot peralihan kecil (~7 %) di tepi
    // Sisi sendiri selalu kedalaman sendiri; sisi seberang = rata-rata seberang di dalam pita.
    expect(soft.foreground[10 * W + 40]).toBeCloseTo(0.8, 6);
    expect(soft.background[10 * W + 40]).toBeCloseTo(0.1, 6);
  });
});
