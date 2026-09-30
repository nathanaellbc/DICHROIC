/** Gaussian-weighted, self-guided detail attenuation; reference for the GPU stage. */
export function softenKernel(edge: number): { sigma: number; radius: number; weights: number[] } {
  const sigma = Math.max(0.35, Math.min(4, 1.5 * edge / 4096));
  const radius = Math.ceil(2 * sigma);
  const weights = Array.from({ length: 2 * radius + 1 }, (_, i) => Math.exp(-0.5 * ((i - radius) / sigma) ** 2));
  const sum = weights.reduce((a, b) => a + b, 0);
  return { sigma, radius, weights: weights.map((v) => v / sum) };
}
export function softenDetailReference(rgba: Float32Array, width: number, height: number, amount: number, edge = Math.max(width, height), luma: readonly number[] = [0.2126, 0.7152, 0.0722]): Float32Array {
  if (amount === 0) return rgba.slice();
  const { radius, weights } = softenKernel(edge);
  const intensity = Float64Array.from({ length: width * height }, (_, i) => Math.log1p(Math.max(0, luma[0]! * rgba[i * 4]! + luma[1]! * rgba[i * 4 + 1]! + luma[2]! * rgba[i * 4 + 2]!)));
  const blur = (input: Float64Array) => {
    const h = new Float64Array(input.length), out = new Float64Array(input.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let k = -radius; k <= radius; k++) h[y * width + x]! += weights[k + radius]! * input[y * width + Math.min(width - 1, Math.max(0, x + k))]!;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let k = -radius; k <= radius; k++) out[y * width + x]! += weights[k + radius]! * h[Math.min(height - 1, Math.max(0, y + k)) * width + x]!;
    return out;
  };
  const mean = blur(intensity), square = blur(intensity.map((v) => v * v));
  const a = mean.map((m, i) => { const v = Math.max(0, square[i]! - m * m); return v / (v + 0.0025); });
  const b = mean.map((m, i) => m * (1 - a[i]!));
  const ma = blur(a), mb = blur(b), out = rgba.slice();
  for (let i = 0; i < intensity.length; i++) {
    const before = Math.expm1(intensity[i]!);
    const after = Math.expm1(ma[i]! * intensity[i]! + mb[i]!);
    const gain = before > 1e-6 ? Math.min(1.25, Math.max(0.8, after / before)) : 1;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = rgba[i * 4 + c]! * (1 + amount * 0.75 * (gain - 1));
  }
  return out;
}
