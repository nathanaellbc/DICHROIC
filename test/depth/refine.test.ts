import { describe, it, expect } from 'vitest';
import {
  jointBilateralUpsample,
  modelInputSize,
  normaliseDisparity,
  resampleRGB,
  rgbaFrom,
  toModelTensor,
} from '../../src/depth/refine';
import { DEPTH_MODEL } from '../../src/depth/model';

/**
 * Bagian numerik estimasi kedalaman (`src/depth/refine.ts`) -- semua kecuali
 * jaringan -- diuji di Node. Acuan: pra-proses Depth Anything V2
 * (`Resize(lower_bound, ensure_multiple_of=14)`, `NormalizeImage` ImageNet,
 * `PrepareForNet` HWC -> CHW) dan sifat upsample bilateral bersama.
 */

function rgba(width: number, height: number, f: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = f(x, y);
      out.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return out;
}

describe('modelInputSize', () => {
  it('sisi pendek = inputSize, keduanya kelipatan 14 (lower_bound)', () => {
    expect(modelInputSize(1536, 1024)).toEqual([784, 518]);
    expect(modelInputSize(1024, 1536)).toEqual([518, 784]);
    expect(modelInputSize(1000, 1000)).toEqual([518, 518]);
    const [w, h] = modelInputSize(1234, 777);
    expect(w % DEPTH_MODEL.multipleOf).toBe(0);
    expect(h % DEPTH_MODEL.multipleOf).toBe(0);
    expect(Math.min(w, h)).toBeGreaterThanOrEqual(DEPTH_MODEL.inputSize);
  });

  it('profil HP memakai sisi pendek 392', () => {
    expect(modelInputSize(1024, 683, 392)).toEqual([588, 392]);
  });
});

describe('resampleRGB', () => {
  it('ukuran sama: nilai asli dinormalisasi ke 0..1', () => {
    const src = rgba(4, 3, (x, y) => [x * 60, y * 100, 255]);
    const out = resampleRGB(src, 4, 3, 4, 3);
    expect(out.length).toBe(4 * 3 * 3);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[(1 * 4 + 3) * 3]).toBeCloseTo(180 / 255, 6);
    expect(out[(2 * 4 + 0) * 3 + 1]).toBeCloseTo(200 / 255, 6);
    expect(out[2]).toBeCloseTo(1, 6);
  });

  it('warna seragam tetap seragam saat diperbesar atau diperkecil', () => {
    const src = rgba(37, 23, () => [51, 102, 204]);
    for (const [dw, dh] of [[74, 46], [13, 9]] as const) {
      const out = resampleRGB(src, 37, 23, dw, dh);
      for (let i = 0; i < dw * dh; i += 1) {
        expect(out[i * 3]).toBeCloseTo(0.2, 5);
        expect(out[i * 3 + 1]).toBeCloseTo(0.4, 5);
        expect(out[i * 3 + 2]).toBeCloseTo(0.8, 5);
      }
    }
  });

  it('memperkecil mempertahankan rata-rata (antialias)', () => {
    const src = rgba(64, 64, (x) => (x % 2 === 0 ? [0, 0, 0] : [255, 255, 255]));
    const out = resampleRGB(src, 64, 64, 16, 16);
    let sum = 0;
    for (let i = 0; i < 16 * 16; i += 1) sum += out[i * 3]!;
    expect(sum / 256).toBeCloseTo(0.5, 2);
    // Pola ini tepat di Nyquist sumber. Tanpa antialias (cv2.INTER_CUBIC polos
    // mengambil sampel tiap 4 px) hasilnya 0 atau 1 -- aliasing penuh ±0,5.
    // Kernel kubik yang direntangkan menekannya ke sisa lobus negatifnya
    // (terukur 0,072), bukan nol; yang dijaga adalah penekanan itu.
    for (let i = 0; i < 16 * 16; i += 1) expect(Math.abs(out[i * 3]! - 0.5)).toBeLessThan(0.1);
  });

  it('hasil selalu di 0..1 walau kernel kubik overshoot di tepi tajam', () => {
    const src = rgba(16, 1, (x) => (x < 8 ? [0, 0, 0] : [255, 255, 255]));
    const out = resampleRGB(src, 16, 1, 40, 1);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('toModelTensor', () => {
  it('normalisasi ImageNet dan tata letak CHW', () => {
    const rgb = Float32Array.of(0.485, 0.456, 0.406, 1, 0, 0.5);
    const t = toModelTensor(rgb, 2, 1);
    expect(t.length).toBe(6);
    expect(t[0]).toBeCloseTo(0, 6); // R piksel 0
    expect(t[2]).toBeCloseTo(0, 6); // G piksel 0 (bidang G mulai di indeks 2)
    expect(t[4]).toBeCloseTo(0, 6); // B piksel 0
    expect(t[1]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(t[3]).toBeCloseTo((0 - 0.456) / 0.224, 5);
    expect(t[5]).toBeCloseTo((0.5 - 0.406) / 0.225, 5);
  });
});

describe('jointBilateralUpsample', () => {
  it('disparitas seragam tetap seragam', () => {
    const low = new Float32Array(6 * 4).fill(0.37);
    const lowGuide = new Float32Array(6 * 4 * 3).fill(0.5);
    const hi = rgba(24, 16, () => [128, 128, 128]);
    const up = jointBilateralUpsample(low, 6, 4, lowGuide, hi, 24, 16);
    expect(up.length).toBe(24 * 16);
    for (const v of up) expect(v).toBeCloseTo(0.37, 5);
  });

  it('tepi mengikuti guide resolusi penuh, bukan interpolasi bilinear', () => {
    // Subjek dekat (disparitas 1, putih) di kiri, latar jauh (0, hitam) di
    // kanan. Guide rendah menaruh tepi di antara sampel 3 dan 4; guide penuh
    // menaruhnya tepat di x = 16 dari 32.
    const lw = 8;
    const low = new Float32Array(lw).map((_, i) => (i < 4 ? 1 : 0));
    const lowGuide = new Float32Array(lw * 3).map((_, i) => (Math.floor(i / 3) < 4 ? 1 : 0));
    const hw = 32;
    const hi = rgba(hw, 1, (x) => (x < 16 ? [255, 255, 255] : [0, 0, 0]));
    const up = jointBilateralUpsample(low, lw, 1, lowGuide, hi, hw, 1);
    // Piksel tepat di kedua sisi tepi penuh tidak bercampur.
    expect(up[15]).toBeGreaterThan(0.95);
    expect(up[16]).toBeLessThan(0.05);
    // Bilinear murni akan memberi ~0,5 di sana.
  });

  it('jatuh ke bilinear bila semua bobot rentang underflow', () => {
    const low = Float32Array.of(0, 1);
    const lowGuide = Float32Array.of(0, 0, 0, 0, 0, 0);
    const hi = rgba(3, 1, () => [255, 255, 255]); // jauh dari guide rendah
    const up = jointBilateralUpsample(low, 2, 1, lowGuide, hi, 3, 1, 0.9, 0.01);
    expect(up[0]).toBeCloseTo(0, 5);
    expect(up[1]).toBeCloseTo(0.5, 5);
    expect(up[2]).toBeCloseTo(1, 5);
  });
});

describe('normaliseDisparity', () => {
  it('persentil 0,5 -> 0 dan 99,5 -> 1, dijepit ke 0..1,5', () => {
    const d = new Float32Array(1000).map((_, i) => 10 + i / 10); // 10..109.9
    const out = normaliseDisparity(d);
    expect(out[0]).toBe(0);
    expect(out[500]).toBeCloseTo(0.5, 1);
    expect(out[999]).toBeGreaterThanOrEqual(1);
    expect(out[999]).toBeLessThanOrEqual(1.5);
    for (const v of out) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1.5);
    }
  });

  it('segelintir piksel berderau tidak menentukan jangkar jauh', () => {
    const d = new Float32Array(2000).fill(5);
    for (let i = 0; i < 1000; i += 1) d[i] = 5 + i / 100; // 5..15
    d[1999] = -1000; // satu piksel langit rusak
    const out = normaliseDisparity(d);
    expect(out[0]).toBe(0);
    expect(out[999]).toBeGreaterThan(0.9);
  });

  it('peta datar tidak membagi dengan nol', () => {
    const out = normaliseDisparity(new Float32Array(100).fill(3));
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('rgbaFrom', () => {
  it('RGB 0..1 -> RGBA8 dengan alpha penuh', () => {
    expect(Array.from(rgbaFrom(Float32Array.of(0, 0.5, 1), 1, 1))).toEqual([0, 128, 255, 255]);
  });
});
