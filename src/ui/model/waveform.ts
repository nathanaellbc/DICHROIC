/**
 * Waveform dan parade gaya DaVinci Resolve -- bagian numerik (bebas DOM).
 *
 * Konvensi Resolve:
 *  - Sumbu x = posisi horizontal di gambar (kiri ke kanan), sumbu y = level
 *    sinyal ter-encode yang tampil, 0 di bawah dan 1 (10-bit 1023) di atas.
 *    Graticule berlabel skala 10-bit: 0, 128, 256, ... 896, 1023.
 *  - Waveform: mode Y (luma Rec.709), RGB (R, G, B bertumpuk; tiap kanal bisa
 *    dimatikan) atau CbCr (selisih warna, 0.5 = netral).
 *  - Parade: komponen berdampingan -- RGB, YRGB, atau YCbCr.
 *  - Colorize (bawaan menyala di Resolve): RGB/parade digambar merah, hijau,
 *    biru yang dijumlahkan (bagian netral tampak putih), Y diwarnai warna
 *    pikselnya; mati = trace putih polos.
 *  - Low Pass Filter: meredam derau trace (rata-rata horizontal 5 piksel).
 *  - Extents: garis batas nilai tertinggi dan terendah per kolom.
 * Kecerahan trace logaritmik terhadap kepadatan per kolom, seperti fosfor.
 */
import { CB_SCALE, CR_SCALE, REC709_LUMA } from './vectorscope';
import type { ParadeMode, WaveMode } from './vectorscope';

/** Garis graticule (nilai 10-bit) seperti Resolve. */
export const WAVEFORM_LINES_10BIT = [0, 128, 256, 384, 512, 640, 768, 896, 1023] as const;

export type ChannelId = 'y' | 'r' | 'g' | 'b' | 'cb' | 'cr';

/**
 * Warna kanal saat Colorize. R, G, B dipilih supaya jumlahnya netral (tiap
 * komponen berjumlah 1.35): trace R+G+B yang bertumpuk tampak putih, seperti
 * waveform RGB Resolve.
 */
export const CHANNEL_COLORS: Readonly<Record<ChannelId, [number, number, number]>> = {
  y: [0.92, 0.94, 0.96],
  r: [1, 0.15, 0.2],
  g: [0.2, 1, 0.15],
  b: [0.15, 0.2, 1],
  cb: [0.35, 0.55, 1],
  cr: [1, 0.35, 0.45],
};

export interface WaveLayout {
  channels: ChannelId[];
  /** `true` = tiap kanal di lajurnya sendiri (parade), `false` = bertumpuk. */
  lanes: boolean;
}

export function waveformLayout(mode: WaveMode, rgb: readonly boolean[] = [true, true, true]): WaveLayout {
  if (mode === 'y') return { channels: ['y'], lanes: false };
  if (mode === 'cbcr') return { channels: ['cb', 'cr'], lanes: false };
  const channels = (['r', 'g', 'b'] as const).filter((_, i) => rgb[i] !== false);
  return { channels: channels.length ? [...channels] : ['r', 'g', 'b'], lanes: false };
}

export function paradeLayout(mode: ParadeMode): WaveLayout {
  if (mode === 'yrgb') return { channels: ['y', 'r', 'g', 'b'], lanes: true };
  if (mode === 'ycbcr') return { channels: ['y', 'cb', 'cr'], lanes: true };
  return { channels: ['r', 'g', 'b'], lanes: true };
}

/** Celah antar lajur parade, px kanvas. */
export function paradeGap(width: number): number {
  return Math.max(2, Math.round(width * 0.012));
}

/** Kolom awal dan lebar lajur ke-`index` dari `count` lajur. */
export function laneBox(width: number, count: number, index: number): { x: number; width: number } {
  if (count <= 1) return { x: 0, width };
  const gap = paradeGap(width);
  const lane = Math.floor((width - (count - 1) * gap) / count);
  return { x: index * (lane + gap), width: lane };
}

export interface WaveTrace {
  width: number;
  height: number;
  channels: ChannelId[];
  /** Kepadatan per kanal, baris atas = level 1. */
  density: Float32Array[];
  /** Jumlah warna piksel per bin untuk Y ber-Colorize (null bila tak ada kanal Y). */
  colorSum: Float32Array | null;
  /** Baris terendah (nilai tertinggi) dan tertinggi per kolom per kanal; -1 = kosong. */
  extentTop: Int32Array[];
  extentBottom: Int32Array[];
  /** Sampel per kolom kanvas (untuk normalisasi kecerahan). */
  perColumn: number;
}

/** Baris kanvas untuk level 0..1 (1 di atas). Level di luar rentang dijepit ke tepi. */
export function levelRow(level: number, height: number): number {
  const v = Math.min(1, Math.max(0, level));
  return Math.min(height - 1, Math.floor((1 - v) * (height - 1) + 0.5));
}

function channelValue(id: ChannelId, r: number, g: number, b: number): number {
  switch (id) {
    case 'r':
      return r;
    case 'g':
      return g;
    case 'b':
      return b;
    case 'y':
      return REC709_LUMA.r * r + REC709_LUMA.g * g + REC709_LUMA.b * b;
    case 'cb':
      return 0.5 + (b - (REC709_LUMA.r * r + REC709_LUMA.g * g + REC709_LUMA.b * b)) / CB_SCALE;
    case 'cr':
      return 0.5 + (r - (REC709_LUMA.r * r + REC709_LUMA.g * g + REC709_LUMA.b * b)) / CR_SCALE;
  }
}

/**
 * Akumulasi piksel RGBA8 ke kanvas `width` x `height` menurut `layout`. Kolom
 * gambar dipetakan linear ke kolom lajurnya; gambar besar dicuplik merata
 * sampai `maxSamples`. Jitter +-0.5 LSB menghapus garis kuantisasi 8-bit
 * (kecuali kode 0 dan 255, supaya hitam/putih penuh tepat di 0/1023).
 */
export function accumulateWaveform(
  pixels: Uint8ClampedArray,
  imageWidth: number,
  imageHeight: number,
  width: number,
  height: number,
  layout: WaveLayout,
  options: { lowPass?: boolean; maxSamples?: number } = {},
): WaveTrace {
  const { channels, lanes } = layout;
  const maxSamples = options.maxSamples ?? 600_000;
  const density = channels.map(() => new Float32Array(width * height));
  const extentTop = channels.map(() => new Int32Array(width).fill(-1));
  const extentBottom = channels.map(() => new Int32Array(width).fill(-1));
  const yIndex = channels.indexOf('y');
  const colorSum = yIndex >= 0 ? new Float32Array(width * height * 3) : null;
  const boxes = channels.map((_, i) => (lanes ? laneBox(width, channels.length, i) : { x: 0, width }));
  const n = imageWidth * imageHeight;
  const stride = Math.max(1, Math.round(Math.sqrt(n / maxSamples)));
  let seed = 0x2545f491;
  const jitter = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296 - 0.5) / 255;
  };
  const level = (code: number) => (code === 0 || code === 255 ? code / 255 : code / 255 + jitter());
  const lp = options.lowPass ? 2 : 0;
  let rows = 0;
  for (let y = 0; y < imageHeight; y += stride) {
    rows += 1;
    const row = y * imageWidth;
    for (let x = 0; x < imageWidth; x += stride) {
      let r: number;
      let g: number;
      let b: number;
      if (lp) {
        let sr = 0;
        let sg = 0;
        let sb = 0;
        let count = 0;
        for (let dx = -lp; dx <= lp; dx += 1) {
          const xx = Math.min(imageWidth - 1, Math.max(0, x + dx));
          const i = (row + xx) * 4;
          sr += pixels[i]!;
          sg += pixels[i + 1]!;
          sb += pixels[i + 2]!;
          count += 1;
        }
        r = sr / count / 255;
        g = sg / count / 255;
        b = sb / count / 255;
      } else {
        const i = (row + x) * 4;
        r = level(pixels[i]!);
        g = level(pixels[i + 1]!);
        b = level(pixels[i + 2]!);
      }
      for (let c = 0; c < channels.length; c += 1) {
        const box = boxes[c]!;
        const col = box.x + Math.min(box.width - 1, Math.floor((x / imageWidth) * box.width));
        const rowIndex = levelRow(channelValue(channels[c]!, r, g, b), height);
        const k = rowIndex * width + col;
        density[c]![k]! += 1;
        if (c === yIndex && colorSum) {
          colorSum[k * 3]! += r;
          colorSum[k * 3 + 1]! += g;
          colorSum[k * 3 + 2]! += b;
        }
        const top = extentTop[c]!;
        const bottom = extentBottom[c]!;
        if (top[col] === -1 || rowIndex < top[col]!) top[col] = rowIndex;
        if (bottom[col] === -1 || rowIndex > bottom[col]!) bottom[col] = rowIndex;
      }
    }
  }
  const laneWidth = boxes[0]!.width;
  const columnsUsed = Math.max(1, Math.min(laneWidth, Math.ceil(imageWidth / stride)));
  const perColumn = (rows * Math.ceil(imageWidth / stride)) / columnsUsed;
  return { width, height, channels, density, colorSum, extentTop, extentBottom, perColumn };
}

/**
 * Trace -> RGBA. Colorize: kanal dijumlahkan dalam warnanya (R+G+B setara =
 * putih), Y diwarnai warna rata-rata pikselnya. Tanpa Colorize: putih polos.
 * Extents: piksel batas atas/bawah per kolom digambar terang.
 */
export function shadeWaveform(trace: WaveTrace, colorize: boolean, extents = false, gain = 1): Uint8ClampedArray {
  const { width, height, density, channels, colorSum, perColumn } = trace;
  const out = new Uint8ClampedArray(width * height * 4);
  const ref = Math.max(1, (perColumn / height) * 40);
  const norm = 1 / Math.log1p(ref);
  const yIndex = channels.indexOf('y');
  for (let k = 0; k < width * height; k += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let c = 0; c < density.length; c += 1) {
      const d = density[c]![k]!;
      if (d <= 0) continue;
      const v = Math.min(1, Math.log1p(d * 6 * gain) * norm * 0.9 + 0.14);
      let color = colorize ? CHANNEL_COLORS[channels[c]!] : CHANNEL_COLORS.y;
      if (colorize && c === yIndex && colorSum) {
        const cr = colorSum[k * 3]! / d;
        const cg = colorSum[k * 3 + 1]! / d;
        const cbv = colorSum[k * 3 + 2]! / d;
        const m = Math.max(cr, cg, cbv, 1e-6);
        // Pudarkan ke putih supaya piksel gelap tetap terbaca.
        color = [0.35 + 0.65 * (cr / m), 0.35 + 0.65 * (cg / m), 0.35 + 0.65 * (cbv / m)];
      }
      r += color[0] * v;
      g += color[1] * v;
      b += color[2] * v;
      a = Math.max(a, v);
    }
    if (a <= 0) continue;
    const m = Math.max(r, g, b, 1e-6);
    // Warna dinormalisasi ke kanal maksimum; intensitas di alfa.
    out[k * 4] = (r / m) * 255;
    out[k * 4 + 1] = (g / m) * 255;
    out[k * 4 + 2] = (b / m) * 255;
    out[k * 4 + 3] = a * 255;
  }
  if (extents) {
    for (let c = 0; c < channels.length; c += 1) {
      const color = colorize ? CHANNEL_COLORS[channels[c]!] : CHANNEL_COLORS.y;
      for (const rows of [trace.extentTop[c]!, trace.extentBottom[c]!]) {
        for (let x = 0; x < width; x += 1) {
          const row = rows[x]!;
          if (row < 0) continue;
          const k = row * width + x;
          out[k * 4] = color[0] * 255;
          out[k * 4 + 1] = color[1] * 255;
          out[k * 4 + 2] = color[2] * 255;
          out[k * 4 + 3] = 255;
        }
      }
    }
  }
  return out;
}
