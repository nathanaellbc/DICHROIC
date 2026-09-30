/**
 * Konversi piksel untuk layar: hasil render (`rgb_out`, sudah ter-encode di
 * `outputColorSpace`) dan pratinjau "sebelum" dari gambar asli.
 */
import type { DecodedImage } from './decoded';
import { boxDownscale } from '../session/downscale';
import { rgbToRgba8 } from './canvasEncode';
import { outputColorSpaces } from '../../public/data/manifest.json';
import type { OutputColorSpaceSpec } from '../profiles/types';
import { bradford } from './icc';

export interface Frame {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  /** Ruang warna kanvas; hanya `display-p3` bila keluarannya memang P3. */
  colorSpace: PredefinedColorSpace;
}

/**
 * RGB f32 rapat -> RGBA 8-bit, kuantisasi yang sama dengan ekspor PNG 8-bit
 * (dulu `v*255 + 0.5` ke `Uint8ClampedArray`, yang sudah membulatkan sendiri:
 * bias setengah level ke atas).
 */
export function rgbToPixels(rgb: Float32Array, width: number, height: number, outputColorSpace = 'sRGB'): Uint8ClampedArray {
  return rgbToCanvas(rgb, width, height, outputColorSpace, canvasColorSpaceFor(outputColorSpace));
}

/** Decode the selected transfer curve, adapt white, then encode for canvas. */
export function rgbToCanvas(
  rgb: Float32Array, width: number, height: number, sourceLabel: string,
  target: PredefinedColorSpace = 'srgb',
  specs = outputColorSpaces as unknown as Record<string, OutputColorSpaceSpec>,
): Uint8ClampedArray {
  const targetLabel = target === 'display-p3' ? 'Display P3' : 'sRGB';
  if (sourceLabel === targetLabel) return rgbToRgba8(rgb, width, height);
  const source = sourceLabel === 'Linear Rec.709' ? { ...specs.sRGB!, encoding: 'linear' as const } : specs[sourceLabel];
  const destination = specs[targetLabel];
  if (!source || !destination) throw new RangeError(`Unsupported display color space: ${sourceLabel}`);
  const adapt = bradford(source.whitepointXyz, destination.whitepointXyz);
  const mul = (a: readonly number[], b: readonly number[]) => Array.from({ length: 9 }, (_, i) =>
    [0, 1, 2].reduce((sum, k) => sum + a[Math.floor(i / 3) * 3 + k]! * b[k * 3 + i % 3]!, 0));
  const m = mul(destination.xyzToRgb, mul(adapt.flat(), source.rgbToXyz));
  const decode = (v: number): number => {
    if (source.encoding === 'linear') return v;
    if (source.encoding === 'srgb') return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    if (source.encoding === 'romm') return v < 1 / 32 ? v / 16 : v ** 1.8;
    return Math.max(0, v) ** (source.gamma ?? 1);
  };
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const r = decode(rgb[i * 3]!); const g = decode(rgb[i * 3 + 1]!); const b = decode(rgb[i * 3 + 2]!);
    pixels[i * 4] = srgbEncode(m[0]! * r + m[1]! * g + m[2]! * b) * 255;
    pixels[i * 4 + 1] = srgbEncode(m[3]! * r + m[4]! * g + m[5]! * b) * 255;
    pixels[i * 4 + 2] = srgbEncode(m[6]! * r + m[7]! * g + m[8]! * b) * 255;
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

export function canvasColorSpaceFor(outputColorSpace: string): PredefinedColorSpace {
  return outputColorSpace === 'Display P3' ? 'display-p3' : 'srgb';
}

/** Ruang keluaran yang tampil benar di kanvas sRGB/P3 (sisanya nilai ter-encode apa adanya). */
export function isDisplayReferred(outputColorSpace: string): boolean {
  return outputColorSpace === 'sRGB' || outputColorSpace === 'Display P3';
}

type Matrix = readonly [number, number, number, number, number, number, number, number, number];

/** Primer linear -> Rec.709/sRGB linear (Bradford untuk titik putih ACES). */
export const TO_REC709: Record<string, Matrix> = {
  'Linear Rec.709': [1, 0, 0, 0, 1, 0, 0, 0, 1],
  'ACES2065-1': [2.52169, -1.13413, -0.38756, -0.27648, 1.37272, -0.09624, -0.01538, -0.15298, 1.16835],
  ACEScg: [1.70505, -0.62179, -0.08326, -0.13026, 1.1408, -0.01055, -0.024, -0.12897, 1.15297],
  'Linear Rec.2020': [1.66049, -0.58764, -0.07285, -0.12455, 1.1329, -0.00835, -0.01815, -0.10058, 1.11873],
  'Linear P3-D65': [1.22494, -0.22494, 0, -0.04206, 1.04206, 0, -0.01964, -0.07864, 1.09828],
};

export function srgbEncode(v: number): number {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * Pratinjau "sebelum" (tanpa emulasi film) seukuran pratinjau render
 * (`boxDownscale` yang sama dengan `Session`). Nilai ter-encode ditampilkan
 * apa adanya; nilai linear dikonversi ke sRGB. Ini hanya pembanding visual,
 * bukan konversi warna yang digerbangi.
 */
export function originalFrame(image: DecodedImage, maxLongEdge: number): Frame {
  const scaled = boxDownscale(image.rgba, image.width, image.height, maxLongEdge);
  const { width, height, rgba } = scaled;
  const n = width * height;
  if (image.suggestedColorSpace === 'Linear Rec.709' || Object.hasOwn(outputColorSpaces, image.suggestedColorSpace)) {
    const rgb = new Float32Array(n * 3);
    for (let i = 0; i < n; i += 1) rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
    const colorSpace = canvasColorSpaceFor(image.suggestedColorSpace);
    return { width, height, pixels: rgbToCanvas(rgb, width, height, image.suggestedColorSpace, colorSpace), colorSpace };
  }
  const pixels = new Uint8ClampedArray(n * 4);
  const matrix = image.encoding === 'linear' ? TO_REC709[image.suggestedColorSpace] ?? TO_REC709['Linear Rec.709']! : undefined;
  for (let i = 0; i < n; i += 1) {
    const r = rgba[i * 4]!;
    const g = rgba[i * 4 + 1]!;
    const b = rgba[i * 4 + 2]!;
    const o = i * 4;
    if (matrix) {
      pixels[o] = srgbEncode(matrix[0] * r + matrix[1] * g + matrix[2] * b) * 255;
      pixels[o + 1] = srgbEncode(matrix[3] * r + matrix[4] * g + matrix[5] * b) * 255;
      pixels[o + 2] = srgbEncode(matrix[6] * r + matrix[7] * g + matrix[8] * b) * 255;
    } else {
      pixels[o] = r * 255;
      pixels[o + 1] = g * 255;
      pixels[o + 2] = b * 255;
    }
    pixels[o + 3] = 255;
  }
  const colorSpace = image.encoding === 'encoded' && image.suggestedColorSpace === 'Display P3' ? 'display-p3' : 'srgb';
  return { width, height, pixels, colorSpace };
}
