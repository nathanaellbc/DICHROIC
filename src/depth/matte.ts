/**
 * Detail halus lens blur (rambut, bulu, tepi kain): bagian numerik setelah
 * jaringan, bebas worker dan GPU supaya bisa diuji di Node.
 *
 *  1. `refineDepth`: guided filter (He, Sun, Tang 2010/2013) pada disparitas
 *     dengan foto resolusi guide sebagai panduan -- derau jaringan dibersihkan
 *     tanpa melunakkan tepi yang sejajar tepi foto. (Guided filter merata-ratakan
 *     per sisi warna, jadi ia tidak memindahkan tepi yang meleset; itu tugas
 *     langkah 2.)
 *  2. `depthLayers`: di zona diskontinuitas (subjek di depan latar), dua lapis
 *     per piksel seperti Portrait Mode -- kedalaman depan, kedalaman latar di
 *     belakangnya, dan matte lembut dari proyeksi warna lokal (subjek vs latar)
 *     yang dibersihkan guided filter. Satu helai rambut lebih tipis dari satu
 *     piksel jaringan; matte menangkapnya dari warna foto, lalu shader
 *     memburamkan latar di sela helai dan meletakkan helai tajam di atasnya.
 *
 * Semua larik Float32 seukuran guide. Kanal guide dikonversi sekali
 * (`GuideImage`) dan statistiknya di-cache per radius; semua lintasan membaca
 * memori baris demi baris (lintasan kolom yang melompat-lompat lambat di JS).
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

/** Transpos berblok (w x h -> h x w): ramah cache untuk lintasan vertikal. */
function transpose(src: Float32Array, w: number, h: number, out: Float32Array): Float32Array {
  const B = 32;
  for (let by = 0; by < h; by += B) {
    for (let bx = 0; bx < w; bx += B) {
      const ye = Math.min(h, by + B), xe = Math.min(w, bx + B);
      for (let y = by; y < ye; y += 1) for (let x = bx; x < xe; x += 1) out[x * h + y] = src[y * w + x]!;
    }
  }
  return out;
}

/** Minimum/maksimum geser per baris (deque monoton, O(n)). */
function extremeRows(src: Float32Array, w: number, h: number, r: number, max: boolean, out: Float32Array): void {
  const queue = new Int32Array(w);
  for (let y = 0; y < h; y += 1) {
    const base = y * w;
    let head = 0, tail = 0, next = 0;
    for (let i = 0; i < w; i += 1) {
      for (; next <= Math.min(w - 1, i + r); next += 1) {
        const v = src[base + next]!;
        if (max) { while (tail > head && v >= src[base + queue[tail - 1]!]!) tail -= 1; }
        else { while (tail > head && v <= src[base + queue[tail - 1]!]!) tail -= 1; }
        queue[tail++] = next;
      }
      while (queue[head]! < i - r) head += 1;
      out[base + i] = src[base + queue[head]!]!;
    }
  }
}

/** Minimum (atau maksimum) jendela (2r+1)^2. */
export function slidingExtreme(src: Float32Array, w: number, h: number, r: number, max: boolean): Float32Array {
  const a = new Float32Array(src.length);
  const b = new Float32Array(src.length);
  extremeRows(src, w, h, r, max, a);
  transpose(a, w, h, b);
  extremeRows(b, h, w, r, max, a);
  return transpose(a, h, w, b);
}

/**
 * Guide 0..1 per kanal, dikonversi sekali; statistik guided filter (rata-rata
 * dan kovarians warna) di-cache per radius karena hanya bergantung pada guide.
 */
export class GuideImage {
  readonly channels: [Float32Array, Float32Array, Float32Array];
  #luma: Float32Array | undefined;
  #color = new Map<number, { mean: Float32Array[]; cov: Float32Array[] }>();
  #gray = new Map<number, { mean: Float32Array; variance: Float32Array }>();

  constructor(rgba: Uint8ClampedArray, readonly width: number, readonly height: number) {
    const n = width * height;
    const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i += 1, j += 4) {
      r[i] = rgba[j]! / 255; g[i] = rgba[j + 1]! / 255; b[i] = rgba[j + 2]! / 255;
    }
    this.channels = [r, g, b];
  }

  get size(): number { return this.width * this.height; }

  get luma(): Float32Array {
    if (!this.#luma) {
      const [r, g, b] = this.channels;
      const l = new Float32Array(this.size);
      for (let i = 0; i < l.length; i += 1) l[i] = 0.2126 * r[i]! + 0.7152 * g[i]! + 0.0722 * b[i]!;
      this.#luma = l;
    }
    return this.#luma;
  }

  colorStats(r: number) {
    let s = this.#color.get(r);
    if (!s) {
      const n = this.size, { width: w, height: h } = this, I = this.channels;
      const tmp = new Float32Array(n), prod = new Float32Array(n);
      const mean = I.map((c) => boxMean(c, w, h, r, new Float32Array(n), tmp));
      const pairs: Array<[number, number]> = [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]];
      const cov = pairs.map(([a, b]) => {
        const A = I[a]!, Bc = I[b]!;
        for (let i = 0; i < n; i += 1) prod[i] = A[i]! * Bc[i]!;
        const m = boxMean(prod, w, h, r, new Float32Array(n), tmp);
        const ma = mean[a]!, mb = mean[b]!;
        for (let i = 0; i < n; i += 1) m[i] = m[i]! - ma[i]! * mb[i]!;
        return m;
      });
      s = { mean, cov };
      this.#color.set(r, s);
    }
    return s;
  }

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

/**
 * Guided filter berpanduan warna (3 kanal). `eps` kecil = keluaran mengikuti
 * tepi warna foto lebih ketat.
 */
export function guidedFilterColor(guide: GuideImage, p: Float32Array, r: number, eps: number): Float32Array {
  const n = guide.size, { width: w, height: h } = guide, I = guide.channels;
  const { mean: mI, cov: v } = guide.colorStats(r);
  const tmp = new Float32Array(n), prod = new Float32Array(n);
  const mp = boxMean(p, w, h, r, new Float32Array(n), tmp);
  // cov(I_c, p)
  const cp = I.map((c, k) => {
    for (let i = 0; i < n; i += 1) prod[i] = c[i]! * p[i]!;
    const m = boxMean(prod, w, h, r, new Float32Array(n), tmp);
    const mk = mI[k]!;
    for (let i = 0; i < n; i += 1) m[i] = m[i]! - mk[i]! * mp[i]!;
    return m;
  });
  const [v0, v1, v2, v3, v4, v5] = v as [Float32Array, Float32Array, Float32Array, Float32Array, Float32Array, Float32Array];
  const [m0, m1, m2] = mI as [Float32Array, Float32Array, Float32Array];
  const [c0a, c1a, c2a] = cp as [Float32Array, Float32Array, Float32Array];
  // a = (Var + eps U)^-1 cov ; b = mp - a . mI   (a menimpa cov(I,p), b menimpa mp)
  for (let i = 0; i < n; i += 1) {
    const rr = v0[i]! + eps, rg = v1[i]!, rb = v2[i]!, gg = v3[i]! + eps, gb = v4[i]!, bb = v5[i]! + eps;
    const i00 = gg * bb - gb * gb, i01 = gb * rb - rg * bb, i02 = rg * gb - gg * rb;
    const i11 = rr * bb - rb * rb, i12 = rb * rg - rr * gb, i22 = rr * gg - rg * rg;
    const inv = 1 / (rr * i00 + rg * i01 + rb * i02);
    const c0 = c0a[i]!, c1 = c1a[i]!, c2 = c2a[i]!;
    const a0 = (i00 * c0 + i01 * c1 + i02 * c2) * inv;
    const a1 = (i01 * c0 + i11 * c1 + i12 * c2) * inv;
    const a2 = (i02 * c0 + i12 * c1 + i22 * c2) * inv;
    c0a[i] = a0; c1a[i] = a1; c2a[i] = a2;
    mp[i] = mp[i]! - (a0 * m0[i]! + a1 * m1[i]! + a2 * m2[i]!);
  }
  const ma0 = boxMean(c0a, w, h, r, prod, tmp);
  const ma1 = boxMean(c1a, w, h, r, c0a, tmp);
  const ma2 = boxMean(c2a, w, h, r, c1a, tmp);
  const mb = boxMean(mp, w, h, r, c2a, tmp);
  const [R, G, B] = I;
  const q = mp;
  for (let i = 0; i < n; i += 1) q[i] = ma0[i]! * R[i]! + ma1[i]! * G[i]! + ma2[i]! * B[i]! + mb[i]!;
  return q;
}

/** Guided filter berpanduan luminans: murah, untuk derau kedalaman dan profil memori rendah. */
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
  /** Lebar zona tepi tempat dua lapis dihitung (helai bisa menjulur sejauh ini). */
  zone: number;
  /** Pembersih matte: kecil supaya helai tetap terpisah. */
  matte: number;
}

export interface DetailOptions {
  /** Matte berpanduan luminans (hemat memori, HP) alih-alih berwarna. */
  lowMemory: boolean;
  /** Ganti radius bawaan (tes). */
  radii?: Partial<DetailRadii>;
}

/** Radius yang mengikuti ukuran guide (px guide). */
export function detailRadii(w: number, h: number, override?: Partial<DetailRadii>): DetailRadii {
  const L = Math.max(w, h);
  return {
    depth: Math.max(2, Math.round(L / 320)),
    zone: Math.max(4, Math.round(L / 60)),
    matte: Math.max(1, Math.round(L / 1024)),
    ...override,
  };
}

/** Derau kedalaman dibersihkan tanpa melunakkan tepi yang sejajar foto (guided filter luminans). */
export function refineDepth(depth: Float32Array, guide: GuideImage, o: DetailOptions): Float32Array {
  return guidedFilterGray(guide, depth, detailRadii(guide.width, guide.height, o.radii).depth, 1e-3);
}

/**
 * Matte proyeksi warna di zona tepi: warna rata-rata lokal lapis depan (F)
 * dan latar (B) dari topeng kedalaman, lalu tiap piksel diproyeksikan ke
 * garis B -> F. Helai pirang di depan latar ungu mendapat ~1 walau jauh dari
 * tepi topeng -- guided filter saja hanya menyebar sejauh radiusnya. Bila F
 * dan B hampir sama warnanya, keyakinannya turun dan matte topeng dipakai.
 */
function colorMatte(guide: GuideImage, mask: Float32Array, maskMatte: Float32Array, r: number): Float32Array {
  const n = guide.size, { width: w, height: h } = guide, I = guide.channels;
  const tmp = new Float32Array(n), prod = new Float32Array(n);
  const wF = boxMean(mask, w, h, r, new Float32Array(n), tmp);
  const mean = (c: Float32Array, fg: boolean) => {
    if (fg) for (let i = 0; i < n; i += 1) prod[i] = c[i]! * mask[i]!;
    else for (let i = 0; i < n; i += 1) prod[i] = c[i]! * (1 - mask[i]!);
    return boxMean(prod, w, h, r, new Float32Array(n), tmp);
  };
  const F = I.map((c) => mean(c, true));
  const Bk = I.map((c) => mean(c, false));
  const out = prod;
  for (let i = 0; i < n; i += 1) {
    const wf = wF[i]!;
    const wb = 1 - wf;
    if (wf < 0.02 || wb < 0.02) { out[i] = maskMatte[i]!; continue; }
    let dot = 0, len2 = 0;
    for (let c = 0; c < 3; c += 1) {
      const f = F[c]![i]! / wf, b = Bk[c]![i]! / wb;
      const d = f - b;
      dot += (I[c]![i]! - b) * d;
      len2 += d * d;
    }
    const projected = Math.min(Math.max(dot / Math.max(len2, 1e-6), 0), 1);
    // Keyakinan: jarak warna F-B 0,05..0,15 (skala 0..1 per kanal).
    const t = Math.min(Math.max((Math.sqrt(len2) - 0.05) / 0.1, 0), 1);
    const confidence = t * t * (3 - 2 * t);
    out[i] = maskMatte[i]! + (projected - maskMatte[i]!) * confidence;
  }
  return out;
}

/** Lompatan disparitas minimum di dalam jendela zona agar dianggap tepi subjek. */
export const LAYER_STEP = 0.06;

export interface DepthLayers {
  /** Kedalaman lapis depan (subjek) -- di luar zona = kedalaman piksel. */
  foreground: Float32Array;
  /** Kedalaman lapis belakang (latar di balik helai) -- di luar zona = kedalaman piksel. */
  background: Float32Array;
  /** Bagian lapis depan di piksel ini, 0..1 -- di luar zona = 1. */
  alpha: Float32Array;
}

/**
 * Dua lapis kedalaman + matte. Di luar zona tepi hasilnya netral (foreground
 * = background = kedalaman, alpha = 1), jadi lens blur keluar sama persis
 * seperti tanpa lapisan.
 */
export function depthLayers(depth: Float32Array, guide: GuideImage, o: DetailOptions): DepthLayers {
  const n = guide.size, { width: w, height: h } = guide;
  const R = detailRadii(w, h, o.radii);
  const near = slidingExtreme(depth, w, h, R.zone, true);
  const far = slidingExtreme(depth, w, h, R.zone, false);
  const tmp = new Float32Array(n);
  // Zona lembut: 0 di bawah satu langkah, 1 di dua langkah -- tanpa tepi keras.
  const zone = new Float32Array(n);
  const mask = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const span = near[i]! - far[i]!;
    const t = Math.min(Math.max((span - LAYER_STEP) / LAYER_STEP, 0), 1);
    zone[i] = t * t * (3 - 2 * t);
    mask[i] = depth[i]! > (near[i]! + far[i]!) * 0.5 ? 1 : 0;
  }
  // Kedalaman tiap lapis dihaluskan supaya tidak berpetak-petak di zona.
  const fgDepth = boxMean(near, w, h, R.zone >> 1, new Float32Array(n), tmp);
  const bgDepth = boxMean(far, w, h, R.zone >> 1, new Float32Array(n), tmp);
  // Matte topeng (tepi rapat) lalu proyeksi warna (helai yang menjulur jauh),
  // dibersihkan sekali lagi dengan guided filter kecil.
  const filter = o.lowMemory ? guidedFilterGray : guidedFilterColor;
  const maskMatte = filter(guide, mask, R.matte, 1e-4);
  const matte = filter(guide, colorMatte(guide, mask, maskMatte, R.zone), R.matte, 1e-5);
  const foreground = near; // dipakai ulang sebagai keluaran
  const background = far;
  const alpha = mask;
  for (let i = 0; i < n; i += 1) {
    const z = zone[i]!;
    const d = depth[i]!;
    foreground[i] = d + (Math.max(fgDepth[i]!, d) - d) * z;
    background[i] = d + (Math.min(bgDepth[i]!, d) - d) * z;
    alpha[i] = 1 - (1 - Math.min(Math.max(matte[i]!, 0), 1)) * z;
  }
  return { foreground, background, alpha };
}

/** Langkah lengkap worker: kedalaman bersih + dua lapis, berbagi satu guide. */
export function detailDepth(depth: Float32Array, rgba: Uint8ClampedArray, w: number, h: number, o: DetailOptions, normalise: (d: Float32Array) => Float32Array) {
  const guide = new GuideImage(rgba, w, h);
  const refined = normalise(refineDepth(depth, guide, o));
  return { depth: refined, layers: depthLayers(refined, guide, o) };
}
