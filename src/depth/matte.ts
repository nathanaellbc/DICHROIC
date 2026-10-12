/**
 * Pembersih kedalaman lens blur: guided filter (He, Sun, Tang 2010/2013) pada
 * disparitas dengan foto resolusi guide sebagai panduan -- derau jaringan
 * dibersihkan tanpa melunakkan tepi yang sejajar tepi foto. Bebas worker dan
 * GPU supaya bisa diuji di Node.
 *
 * (Matte dua lapis untuk rambut pernah ada di sini dan dihapus: pada foto
 * sungguhan tepi kedalaman jaringan meluber ke latar, matte warna salah menilai
 * pita itu, dan latar di sebelah subjek tetap tajam -- blur tidak rapat ke
 * subjek.)
 */

/** Rata-rata kotak (2r+1)^2, jendela dijepit di tepi (dibagi jumlah piksel sah). */
export function boxMean(src: Float32Array, w: number, h: number, r: number, out: Float32Array, tmp: Float32Array): Float32Array {
  // Horizontal: jumlah geser per baris.
  for (let y = 0; y < h; y += 1) {
    const row = y * w;
    let sum = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x += 1) sum += src[row + x]!;
    for (let x = 0; x < w; x += 1) {
      tmp[row + x] = sum / (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1);
      const add = x + r + 1;
      const drop = x - r;
      if (add < w) sum += src[row + add]!;
      if (drop >= 0) sum -= src[row + drop]!;
    }
  }
  // Vertikal pada rata-rata horizontal, baris demi baris: jumlah kolom berjalan.
  const col = new Float64Array(w);
  for (let y = 0; y <= Math.min(r, h - 1); y += 1) {
    const row = y * w;
    for (let x = 0; x < w; x += 1) col[x] = col[x]! + tmp[row + x]!;
  }
  for (let y = 0; y < h; y += 1) {
    const inv = 1 / (Math.min(h - 1, y + r) - Math.max(0, y - r) + 1);
    const row = y * w;
    for (let x = 0; x < w; x += 1) out[row + x] = col[x]! * inv;
    const add = y + r + 1;
    const drop = y - r;
    if (add < h) { const a = add * w; for (let x = 0; x < w; x += 1) col[x] = col[x]! + tmp[a + x]!; }
    if (drop >= 0) { const d = drop * w; for (let x = 0; x < w; x += 1) col[x] = col[x]! - tmp[d + x]!; }
  }
  return out;
}

/**
 * Luminans guide 0..1, dihitung sekali; statistik guided filter (rata-rata dan
 * varians) di-cache per radius karena hanya bergantung pada guide.
 */
export class GuideImage {
  readonly luma: Float32Array;
  #gray = new Map<number, { mean: Float32Array; variance: Float32Array }>();

  constructor(rgba: Uint8ClampedArray, readonly width: number, readonly height: number) {
    const n = width * height;
    this.luma = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i += 1, j += 4) {
      this.luma[i] = (0.2126 * rgba[j]! + 0.7152 * rgba[j + 1]! + 0.0722 * rgba[j + 2]!) / 255;
    }
  }

  get size(): number { return this.width * this.height; }

  grayStats(r: number) {
    let s = this.#gray.get(r);
    if (!s) {
      const n = this.size, { width: w, height: h } = this, I = this.luma;
      const tmp = new Float32Array(n), prod = new Float32Array(n);
      const mean = boxMean(I, w, h, r, new Float32Array(n), tmp);
      for (let i = 0; i < n; i += 1) prod[i] = I[i]! * I[i]!;
      const variance = boxMean(prod, w, h, r, new Float32Array(n), tmp);
      for (let i = 0; i < n; i += 1) variance[i] = variance[i]! - mean[i]! * mean[i]!;
      s = { mean, variance };
      this.#gray.set(r, s);
    }
    return s;
  }
}

/** Guided filter berpanduan luminans. */
export function guidedFilterGray(guide: GuideImage, p: Float32Array, r: number, eps: number): Float32Array {
  const n = guide.size, { width: w, height: h } = guide, I = guide.luma;
  const { mean: mI, variance } = guide.grayStats(r);
  const tmp = new Float32Array(n), prod = new Float32Array(n);
  const mp = boxMean(p, w, h, r, new Float32Array(n), tmp);
  for (let i = 0; i < n; i += 1) prod[i] = I[i]! * p[i]!;
  const a = boxMean(prod, w, h, r, new Float32Array(n), tmp);
  for (let i = 0; i < n; i += 1) {
    const ai = (a[i]! - mI[i]! * mp[i]!) / (variance[i]! + eps);
    a[i] = ai;
    mp[i] = mp[i]! - ai * mI[i]!;
  }
  const ma = boxMean(a, w, h, r, prod, tmp);
  const mb = boxMean(mp, w, h, r, a, tmp);
  for (let i = 0; i < n; i += 1) mp[i] = ma[i]! * I[i]! + mb[i]!;
  return mp;
}

export interface DetailRadii {
  /** Penghalusan kedalaman. */
  depth: number;
}

export interface DetailOptions {
  /** Ganti radius bawaan (tes). */
  radii?: Partial<DetailRadii>;
}

/** Radius yang mengikuti ukuran guide (px guide). */
export function detailRadii(w: number, h: number, override?: Partial<DetailRadii>): DetailRadii {
  return { depth: Math.max(2, Math.round(Math.max(w, h) / 320)), ...override };
}

/** Derau kedalaman dibersihkan tanpa melunakkan tepi yang sejajar foto (guided filter luminans). */
export function refineDepth(depth: Float32Array, guide: GuideImage, o: DetailOptions): Float32Array {
  return guidedFilterGray(guide, depth, detailRadii(guide.width, guide.height, o.radii).depth, 1e-3);
}

/** Langkah lengkap worker: kedalaman dibersihkan berpanduan foto, lalu dinormalisasi. */
export function detailDepth(depth: Float32Array, rgba: Uint8ClampedArray, w: number, h: number, normalise: (d: Float32Array) => Float32Array): Float32Array {
  return normalise(refineDepth(depth, new GuideImage(rgba, w, h), {}));
}
