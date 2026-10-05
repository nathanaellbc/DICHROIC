/**
 * Waveform dan RGB parade gaya DaVinci Resolve -- bagian numerik (bebas DOM).
 *
 * Konvensi Resolve:
 *  - Sumbu x = posisi horizontal di gambar (kiri ke kanan), sumbu y = level
 *    sinyal ter-encode yang tampil, 0 di bawah dan 1 (10-bit 1023) di atas.
 *    Graticule berlabel skala 10-bit: 0, 128, 256, ... 896, 1023.
 *  - Waveform: luma Y' Rec.709 (0.2126 R' + 0.7152 G' + 0.0722 B'), trace putih.
 *  - Parade: R', G', B' berdampingan, masing-masing sepertiga lebar dengan
 *    warnanya sendiri.
 * Kecerahan trace logaritmik terhadap kepadatan per kolom, seperti fosfor.
 */
import { REC709_LUMA } from './vectorscope';

/** Garis graticule (nilai 10-bit) seperti Resolve. */
export const WAVEFORM_LINES_10BIT = [0, 128, 256, 384, 512, 640, 768, 896, 1023] as const;

/** Celah antar kanal parade, px kanvas. */
export function paradeGap(width: number): number {
  return Math.max(2, Math.round(width * 0.012));
}

export interface WaveTrace {
  width: number;
  height: number;
  /** Kepadatan per kanal (1 untuk waveform Y', 3 untuk parade), baris atas = level 1. */
  density: Float32Array[];
  /** Sampel per kolom kanvas (untuk normalisasi kecerahan). */
  perColumn: number;
}

/** Baris kanvas untuk level 0..1 (1 di atas). Level di luar rentang dijepit ke tepi. */
export function levelRow(level: number, height: number): number {
  const v = Math.min(1, Math.max(0, level));
  return Math.min(height - 1, Math.floor((1 - v) * (height - 1) + 0.5));
}

/**
 * Akumulasi piksel RGBA8 ke kanvas `width` x `height`. Waveform: satu bidang
 * selebar kanvas. Parade: tiga bidang, masing-masing selebar sepertiga
 * (dikurangi celah). Kolom gambar dipetakan linear ke kolom bidangnya; gambar
 * besar dicuplik merata sampai `maxSamples`. Jitter +-0.5 LSB menghapus garis
 * kuantisasi 8-bit (kecuali kode 0 dan 255).
 */
export function accumulateWaveform(
  pixels: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  width: number,
  height: number,
  parade: boolean,
  maxSamples = 600_000,
): WaveTrace {
  const planes = parade ? 3 : 1;
  const gap = parade ? paradeGap(width) : 0;
  const laneWidth = parade ? Math.floor((width - 2 * gap) / 3) : width;
  const density = Array.from({ length: planes }, () => new Float32Array(width * height));
  const n = imageWidth * imageHeight;
  const stride = Math.max(1, Math.round(Math.sqrt(n / maxSamples)));
  let seed = 0x2545f491;
  const jitter = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296 - 0.5) / 255;
  };
  // Kode 0 dan 255 tanpa jitter: hitam dan putih penuh tepat di garis 0 dan 1023.
  const level = (code: number) => (code === 0 || code === 255 ? code / 255 : code / 255 + jitter());
  let rows = 0;
  for (let y = 0; y < imageHeight; y += stride) {
    rows += 1;
    for (let x = 0; x < imageWidth; x += stride) {
      const i = (y * imageWidth + x) * 4;
      const r = level(pixels[i]!);
      const g = level(pixels[i + 1]!);
      const b = level(pixels[i + 2]!);
      const lane = Math.min(laneWidth - 1, Math.floor((x / imageWidth) * laneWidth));
      if (!parade) {
        const yv = REC709_LUMA.r * r + REC709_LUMA.g * g + REC709_LUMA.b * b;
        density[0]![levelRow(yv, height) * width + lane]! += 1;
        continue;
      }
      const values = [r, g, b];
      for (let c = 0; c < 3; c += 1) {
        const col = c * (laneWidth + gap) + lane;
        density[c]![levelRow(values[c]!, height) * width + col]! += 1;
      }
    }
  }
  const columnsPerLane = Math.max(1, Math.min(laneWidth, Math.ceil(imageWidth / stride)));
  const perColumn = (rows * Math.ceil(imageWidth / stride)) / columnsPerLane;
  return { width, height, density, perColumn };
}

const TRACE_COLORS: ReadonlyArray<[number, number, number]> = [
  [1, 0.32, 0.3],
  [0.36, 1, 0.42],
  [0.38, 0.55, 1],
];

/** Trace -> RGBA. Parade memakai warna kanal; waveform abu-abu putih. */
export function shadeWaveform(trace: WaveTrace, gain = 1): Uint8ClampedArray {
  const { width, height, density, perColumn } = trace;
  const out = new Uint8ClampedArray(width * height * 4);
  // Referensi: kepadatan bila sampel satu kolom tersebar di ~1/40 tinggi.
  const ref = Math.max(1, (perColumn / height) * 40);
  const norm = 1 / Math.log1p(ref);
  const parade = density.length === 3;
  for (let k = 0; k < width * height; k += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let c = 0; c < density.length; c += 1) {
      const d = density[c]![k]!;
      if (d <= 0) continue;
      const v = Math.min(1, Math.log1p(d * 6 * gain) * norm * 0.9 + 0.14);
      const [cr, cg, cb] = parade ? TRACE_COLORS[c]! : [0.93, 0.95, 0.97];
      r = Math.max(r, cr * v);
      g = Math.max(g, cg * v);
      b = Math.max(b, cb * v);
      a = Math.max(a, v);
    }
    if (a <= 0) continue;
    out[k * 4] = (r / a) * 255;
    out[k * 4 + 1] = (g / a) * 255;
    out[k * 4 + 2] = (b / a) * 255;
    out[k * 4 + 3] = a * 255;
  }
  return out;
}
