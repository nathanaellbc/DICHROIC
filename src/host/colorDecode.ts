/**
 * Decode CCTF input di host (Fase 2C Task 9): port persis `sampleDecodeLut`
 * `filmExposure.wgsl` pada tabel `colorDecodeLuts` yang sama (static arena,
 * `transferLutSize` titik per colour space di [decodeMin, decodeMax],
 * interpolasi linear, ekstrapolasi linear di luar rentang). Dipakai metering
 * auto-exposure, yang di Python (`measure_autoexposure_ev`) men-decode lewat
 * `colour.RGB_to_XYZ(..., apply_cctf_decoding)`.
 */

export interface DecodeLutTable {
  luts: ArrayLike<number>;
  size: number;
  min: number;
  max: number;
}

export function decodeWithLut(table: DecodeLutTable, colorSpace: number, value: number): number {
  const size = Math.max(table.size, 2);
  const range = Math.max(table.max - table.min, 1e-6);
  const step = range / (size - 1);
  const o = colorSpace * size;
  const at = (i: number) => table.luts[o + i]!;
  if (value <= table.min) return at(0) + (value - table.min) * ((at(1) - at(0)) / Math.max(step, 1e-12));
  if (value >= table.max) {
    return at(size - 1) + (value - table.max) * ((at(size - 1) - at(size - 2)) / Math.max(step, 1e-12));
  }
  const position = ((value - table.min) / range) * (size - 1);
  const lo = Math.floor(position);
  const hi = Math.min(lo + 1, size - 1);
  const t = position - lo;
  return at(lo) + (at(hi) - at(lo)) * t;
}
