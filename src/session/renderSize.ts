import type { RenderParams } from '../params/renderParams';
import { FILM_FORMAT_LONG_EDGE_MM } from '../params/filmFormat';
import { diffusionFftBytes, diffusionRadiusPx } from '../engine/stages/diffusionFft';
import { EXPORT_GPU_BYTES_PER_PIXEL } from '../engine/tiling';
import { imageMemoryBudget, previewPixelBudget } from '../io/budget';

/** Byte maksimum satu bidang FFT difusi (dari tiga; lih. `fitForDiffusion`). */
export const DIFFUSION_PLANE_BUDGET = 256 * 1024 * 1024;

/** Bound interactive GPU work, including the grain stage's three-layer buffer. */
export function previewRenderLongEdge(width: number, height: number, requested: number, params: RenderParams, bindingBytes: number, memoryBytes = imageMemoryBudget()): number {
  const pixels = Math.max(1, Math.floor(Math.min(previewPixelBudget(memoryBytes), memoryBytes / 256, bindingBytes / (params.grainEnabled ? 48 : 16))));
  const native = Math.max(width, height);
  let edge = Math.min(native, Math.max(1, Math.round(requested)), Math.floor(Math.sqrt(pixels * native / Math.min(width, height))));
  const fits = (v: number) => v * Math.max(1, Math.round(v * Math.min(width, height) / native)) <= pixels;
  while (edge > 1 && !fits(edge)) edge--;
  return edge;
}

/**
 * Sisi panjang terbesar (<= asli) tempat render penuh dengan difusi aktif
 * muat: frame utuh dalam satu binding storage, dan tiap bidang FFT df64
 * <= min(`planeBudget`, batas binding). Tanpa difusi: sisi panjang asli.
 */
export function diffusionRenderLongEdge(
  width: number,
  height: number,
  params: RenderParams,
  maxBindingBytes: number,
  planeBudget = DIFFUSION_PLANE_BUDGET,
  /** Ekstensi lens blur aktif: juga butuh frame utuh dalam satu binding. */
  lensBlur = false,
  /**
   * Batas working set GPU frame utuh (byte): rantai penuh 192 B/px
   * (`EXPORT_GPU_BYTES_PER_PIXEL`) ditambah bidang FFT difusi. HP memberi
   * batas (`wholeFrameMemoryBudget`); desktop tak terbatas di sini.
   */
  frameBudget = Number.POSITIVE_INFINITY,
): number {
  const original = Math.max(width, height);
  const sites = [
    params.cameraDiffusionEnabled && params.cameraDiffusionStrength > 0
      ? { family: params.cameraDiffusionFamily, strength: params.cameraDiffusionStrength }
      : undefined,
    params.process !== 'scanNegative' && params.printDiffusionEnabled && params.printDiffusionStrength > 0
      ? { family: params.printDiffusionFamily, strength: params.printDiffusionStrength }
      : undefined,
  ].filter((site) => site !== undefined);
  if (sites.length === 0 && !lensBlur) return original;
  const planeLimit = Math.min(planeBudget, maxBindingBytes);
  const filmFormatMm = FILM_FORMAT_LONG_EDGE_MM[params.filmFormat];
  const aspect = Math.min(width, height) / original;
  const dims = (edge: number) =>
    width >= height
      ? { w: edge, h: Math.max(1, Math.round(edge * aspect)) }
      : { w: Math.max(1, Math.round(edge * aspect)), h: edge };
  const fits = (edge: number) => {
    const { w, h } = dims(edge);
    let fftBytes = 0;
    const planesFit = sites.every((site) => {
      const radius = diffusionRadiusPx(site, (filmFormatMm * 1000) / Math.max(w, h), w, h);
      const bytes = diffusionFftBytes(w, h, radius);
      fftBytes += bytes;
      return bytes / 3 <= planeLimit;
    });
    return w * h * 16 <= maxBindingBytes && planesFit && w * h * EXPORT_GPU_BYTES_PER_PIXEL + fftBytes <= frameBudget;
  };
  let edge = original;
  while (edge > 256 && !fits(edge)) edge = Math.floor(edge * 0.9);
  return edge;
}

