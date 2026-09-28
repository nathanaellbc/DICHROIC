/**
 * Konversi piksel integer ter-interleave ke `DecodedImage.rgba` (spec Fase 2
 * §5): `v / (2^bits - 1)` dihitung di f64 lalu dibulatkan sekali ke f32 --
 * persis `(v.astype(float64) / max).astype(float32)` oracle Python, sehingga
 * format lossless bisa digerbangi bit-identik. Grayscale disebar ke RGB;
 * tanpa kanal alpha, alpha = 1.
 */
export function interleavedToRgba(
  data: ArrayLike<number>,
  width: number,
  height: number,
  channels: number,
  maxValue: number,
): Float32Array {
  if (channels < 1 || channels > 4) throw new Error(`jumlah kanal ${channels} tidak didukung`);
  const n = width * height;
  if (data.length < n * channels) {
    throw new Error(`data piksel terpotong: ${data.length} nilai, butuh ${n * channels}`);
  }
  const rgba = new Float32Array(n * 4);
  const gray = channels <= 2;
  const alpha = channels === 2 || channels === 4 ? channels - 1 : -1;
  for (let i = 0; i < n; i += 1) {
    const src = i * channels;
    const dst = i * 4;
    if (gray) {
      const v = data[src]! / maxValue;
      rgba[dst] = v;
      rgba[dst + 1] = v;
      rgba[dst + 2] = v;
    } else {
      rgba[dst] = data[src]! / maxValue;
      rgba[dst + 1] = data[src + 1]! / maxValue;
      rgba[dst + 2] = data[src + 2]! / maxValue;
    }
    rgba[dst + 3] = alpha < 0 ? 1 : data[src + alpha]! / maxValue;
  }
  return rgba;
}
