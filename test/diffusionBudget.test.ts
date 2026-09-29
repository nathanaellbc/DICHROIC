import { describe, expect, it } from 'vitest';
import { diffusionFftBytes, diffusionRadiusPx, fftPlaneSize } from '../src/engine/stages/diffusionFft';
import { BASELINE_RENDER_PARAMS } from '../src/params/renderParams';
import { DIFFUSION_PLANE_BUDGET, diffusionRenderLongEdge } from '../src/session/session';

const GB = 1024 ** 3;
const cinebloom = {
  ...BASELINE_RENDER_PARAMS,
  cameraDiffusionEnabled: true,
  cameraDiffusionFamily: 'cinebloom' as const,
  cameraDiffusionStrength: 1,
};

describe('anggaran memori difusi FFT (Fase 2D Task 4)', () => {
  it('radius mengikuti rumus Python dan klem setengah sisi pendek', () => {
    // 35 mm / 1024 px = 34.18 um/px; lambda_max cinebloom 2500 um -> 8 lambda = 586 px -> klem 683 // 2 - 1 = 340.
    expect(diffusionRadiusPx({ family: 'cinebloom', strength: 1 }, 35000 / 1024, 1024, 683)).toBe(340);
    expect(diffusionRadiusPx({ family: 'cinebloom', strength: 0 }, 35000 / 1024, 1024, 683)).toBe(0);
    expect(fftPlaneSize(1024, 683, 340)).toEqual({ nx: 2048, ny: 2048 });
    expect(diffusionFftBytes(1024, 683, 340)).toBe(2048 * 2048 * 16 * 3);
  });

  it('tanpa difusi dan pada pratinjau: ukuran asli', () => {
    expect(diffusionRenderLongEdge(6000, 4000, BASELINE_RENDER_PARAMS, 2 * GB)).toBe(6000);
    expect(diffusionRenderLongEdge(1024, 683, cinebloom, 2 * GB)).toBe(1024);
  });

  it('render penuh besar diperkecil sampai tiap bidang muat anggaran', () => {
    const edge = diffusionRenderLongEdge(6000, 4000, cinebloom, 2 * GB);
    expect(edge).toBeLessThan(6000);
    const h = Math.round((edge * 4000) / 6000);
    const radius = diffusionRadiusPx({ family: 'cinebloom', strength: 1 }, 35000 / edge, edge, h);
    expect(diffusionFftBytes(edge, h, radius) / 3).toBeLessThanOrEqual(DIFFUSION_PLANE_BUDGET);
    // Batas binding device yang lebih kecil memperkecil lebih jauh.
    expect(diffusionRenderLongEdge(6000, 4000, cinebloom, 128 * 1024 ** 2)).toBeLessThan(edge);
  });

  it('mode scan film mengabaikan difusi enlarger', () => {
    const printOnly = { ...BASELINE_RENDER_PARAMS, printDiffusionEnabled: true, printDiffusionStrength: 1, process: 'scanNegative' as const };
    expect(diffusionRenderLongEdge(6000, 4000, printOnly, 2 * GB)).toBe(6000);
  });
});
