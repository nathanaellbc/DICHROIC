/**
 * Detent sisi panjang lembar Ekspor (pola EMULSION): hanya detent yang
 * sungguh memperkecil yang ditawarkan, plus "Source" -- atau "Max" bila
 * sumber melampaui kanvas terbesar yang bisa di-encode browser (hanya untuk
 * format lossy, yang lewat kanvas).
 */

/** Detent sisi panjang; hanya yang benar-benar memperkecil yang ditawarkan. */
export const LONG_EDGE_DETENTS = [2048, 4096, 8192] as const;

function isAppleMobile(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** iOS WebGPU/export working-set ceiling: about 12 MP, 4096 px on the long edge. */
export const MOBILE_EXPORT_LIMITS = { area: 12_582_912, side: 4096 } as const;

/**
 * Kanvas terbesar yang bisa di-encode browser ini (khusus format lossy):
 * iOS Safari menolak kanvas di atas 16,7 MP.
 */
export function canvasLimits(): { area: number; side: number } {
  return isAppleMobile() ? { area: 16_777_216, side: 16_384 } : { area: 268_435_456, side: 32_767 };
}

/**
 * Mobile gets a lower limit for every output format to keep full-resolution
 * GPU render and encoder buffers within a practical Safari working set.
 */
export function exportSizeLimits(lossy: boolean, mobile = isAppleMobile()): { area: number; side: number } | undefined {
  if (mobile) return MOBILE_EXPORT_LIMITS;
  return lossy ? canvasLimits() : undefined;
}

export interface LongEdgeDetent {
  /** `null` = sumber (atau batas kanvas bila sumber melampauinya). */
  longEdge: number | null;
  label: string;
  width: number;
  height: number;
  /** Sisi panjang yang diminta ke `Session` (`undefined` = sumber). */
  request: number | undefined;
}

/** Detent untuk gambar `w x h`; `limits` hanya untuk encoder kanvas. */
export function longEdgeDetents(w: number, h: number, limits?: { area: number; side: number }): LongEdgeDetent[] {
  const sourceLong = Math.max(w, h);
  const cap = limits ? Math.floor(Math.min(sourceLong, limits.side, Math.sqrt(limits.area / (w * h)) * sourceLong)) : sourceLong;
  const dims = (edge: number) => ({ width: Math.round((w * edge) / sourceLong), height: Math.round((h * edge) / sourceLong) });
  const out: LongEdgeDetent[] = LONG_EDGE_DETENTS.filter((d) => d < cap).map((d) => ({ longEdge: d, label: String(d), ...dims(d), request: d }));
  const capped = cap < sourceLong;
  out.push({ longEdge: null, label: capped ? `Max · ${cap}` : `Source · ${sourceLong}`, ...dims(cap), request: capped ? cap : undefined });
  return out;
}

