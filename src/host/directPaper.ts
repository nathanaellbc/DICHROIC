import type { Arenas } from '../engine/arena';
import { invert3 } from './cameraDevelop';

/** Neutral exposure anchors for the measured paper, without a negative film. */
export function directPaperAnchors(arenas: Arenas): Float32Array {
  const curves = arenas.dynamic.values('printDensityCurvesMorphed');
  const exposure = arenas.dynamic.values('printCurveExposure');
  const count = curves.length / 3;
  const channels = arenas.dynamic.values('scannerChannelDensity');
  const base = arenas.dynamic.values('scannerBaseDensity');
  const illuminant = arenas.dynamic.values('scannerIlluminant');
  const cmfs = arenas.static.values('standardObserverCmfs');
  const matrix = arenas.dynamic.values('scannerToOutputRgb');
  const normalization = arenas.dynamic.values('scannerNormalization')[0]!;
  const rgb = (density: number[]) => {
    const xyz = [0, 0, 0];
    for (let w = 0; w < illuminant.length; w++) {
      const d = base[w]! + density.reduce((sum, v, c) => sum + v * channels[w * 3 + c]!, 0);
      if (!Number.isFinite(d)) continue;
      const light = 10 ** -d * illuminant[w]! / normalization;
      for (let c = 0; c < 3; c++) xyz[c]! += light * cmfs[w * 3 + c]!;
    }
    return [0, 1, 2].map(r => xyz.reduce((sum, v, c) => sum + matrix[r * 3 + c]! * v, 0));
  };
  const density = [0.5, 0.5, 0.5];
  const bounds = [0, 1, 2].map(c => {
    const values = Array.from({ length: count }, (_, i) => curves[i * 3 + c]!);
    return [Math.min(...values), Math.max(...values)] as const;
  });
  for (let iteration = 0; iteration < 24; iteration++) {
    const current = rgb(density).map(v => Math.log(Math.max(v, 1e-6)));
    const error = current.map(v => Math.log(0.184) - v);
    if (Math.max(...error.map(Math.abs)) < 1e-7) break;
    const jacobian = new Array<number>(9);
    for (let c = 0; c < 3; c++) {
      const shifted = [...density]; shifted[c]! += 1e-3;
      const next = rgb(shifted);
      for (let r = 0; r < 3; r++) jacobian[r * 3 + c] = (Math.log(Math.max(next[r]!, 1e-6)) - current[r]!) / 1e-3;
    }
    const inverse = invert3(jacobian);
    for (let c = 0; c < 3; c++) {
      const step = error.reduce((sum, v, r) => sum + inverse[c * 3 + r]! * v, 0);
      density[c] = Math.max(bounds[c]![0], Math.min(bounds[c]![1], density[c]! + Math.max(-0.25, Math.min(0.25, step))));
    }
  }
  const anchors = new Float32Array(8);
  for (let c = 0; c < 3; c++) {
    const increasing = curves[(count - 1) * 3 + c]! >= curves[c]!;
    anchors[4 + c] = increasing ? -1 : 1;
    let best = 0;
    for (let i = 1; i < count; i++) if (Math.abs(curves[i * 3 + c]! - density[c]!) < Math.abs(curves[best * 3 + c]! - density[c]!)) best = i;
    anchors[c] = exposure[best * 2]!;
    for (let i = 0; i < count - 1; i++) {
      const a = curves[i * 3 + c]!, b = curves[(i + 1) * 3 + c]!;
      if (density[c]! >= Math.min(a, b) && density[c]! <= Math.max(a, b) && a !== b) {
        anchors[c] = exposure[i * 2]! + (exposure[(i + 1) * 2]! - exposure[i * 2]!) * (density[c]! - a) / (b - a);
        break;
      }
    }
  }
  return anchors;
}
