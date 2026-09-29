/**
 * Koreksi coupler DIR per render (Fase 2D): matriks crosstalk dan kurva
 * densitas "sebelum DIR" untuk `film_render.dir_couplers` Python
 * (`model/couplers.py`). Dulu (Fase 1) keduanya di-bake per stock dengan
 * `amount`/`inhibition_*` default 1.0; batch parameter 2 membuka ketiganya,
 * jadi dihitung di sini dari gamma stock (arena `stock`, entri `dirGammas`)
 * setiap kali nilainya berubah -- beberapa ratus float, murah, dan tidak
 * menjadi bagian kunci arena (menggeser slider tidak membuat arena GPU baru).
 */

export interface DirCouplerSettings {
  /** `dir_couplers.amount` (pengali seluruh matriks; 0 setara `active=False`). */
  amount: number;
  /** `dir_couplers.inhibition_samelayer` (pengali diagonal). */
  inhibitionSameLayer: number;
  /** `dir_couplers.inhibition_interlayer` (pengali luar-diagonal). */
  inhibitionInterlayer: number;
}

export const DEFAULT_DIR_SETTINGS: Readonly<DirCouplerSettings> = Object.freeze({
  amount: 1,
  inhibitionSameLayer: 1,
  inhibitionInterlayer: 1,
});

/**
 * Port `compute_dir_couplers_matrix(dir_couplers) * dir_couplers.amount`.
 * `gammas` = `[same_r, same_g, same_b, r_to_g, r_to_b, g_to_r, g_to_b,
 * b_to_r, b_to_g]` (urutan field `DirCouplersParams`). Keluaran baris-mayor
 * donor*3+penerima -- sama dengan `contract('jk,km->jm', ...)` Python.
 */
export function computeDirCouplersMatrix(gammas: ArrayLike<number>, settings: DirCouplerSettings): Float32Array {
  const m = new Float64Array(9);
  m[0] = gammas[0]! * settings.inhibitionSameLayer;
  m[4] = gammas[1]! * settings.inhibitionSameLayer;
  m[8] = gammas[2]! * settings.inhibitionSameLayer;
  m[1] = gammas[3]! * settings.inhibitionInterlayer;
  m[2] = gammas[4]! * settings.inhibitionInterlayer;
  m[3] = gammas[5]! * settings.inhibitionInterlayer;
  m[5] = gammas[6]! * settings.inhibitionInterlayer;
  m[6] = gammas[7]! * settings.inhibitionInterlayer;
  m[7] = gammas[8]! * settings.inhibitionInterlayer;
  const out = new Float32Array(9);
  for (let i = 0; i < 9; i += 1) out[i] = m[i]! * settings.amount;
  return out;
}

/**
 * `binary_search_with_guess` NumPy (`numpy/_core/src/multiarray/compiled_base.c`),
 * porting baris per baris. Untuk `xp` yang TIDAK monoton hasil `np.interp`
 * bergantung pada urutan tebakan ini (dokumentasi NumPy menyebutnya "tidak
 * bermakna", tapi tetap deterministik) -- dan itulah yang terjadi pada kurva
 * sebelum DIR bila `amount`/`inhibition_*` besar: `log_exposure_0` terlipat
 * (Portra 400, amount 2: 36 langkah turun di kanal G). Pencarian biner biasa
 * memberi selisih sampai 0.44 densitas di sana; porting ini bit-identik.
 */
function binarySearchWithGuess(key: number, arr: ArrayLike<number>, len: number, guess: number): number {
  const LIKELY_IN_CACHE_SIZE = 8;
  let imin = 0;
  let imax = len;
  if (key > arr[len - 1]!) return len;
  if (key < arr[0]!) return -1;
  if (len <= 4) {
    // `linear_search(key, arr, len, 1)`
    let i = 1;
    for (; i < len && key >= arr[i]!; i += 1);
    return i - 1;
  }
  let g = guess;
  if (g > len - 3) g = len - 3;
  if (g < 1) g = 1;
  if (key < arr[g]!) {
    if (key < arr[g - 1]!) {
      imax = g - 1;
      if (g > LIKELY_IN_CACHE_SIZE && key >= arr[g - LIKELY_IN_CACHE_SIZE]!) imin = g - LIKELY_IN_CACHE_SIZE;
    } else {
      return g - 1;
    }
  } else if (key < arr[g + 1]!) {
    return g;
  } else if (key < arr[g + 2]!) {
    return g + 1;
  } else {
    imin = g + 2;
    if (g < len - LIKELY_IN_CACHE_SIZE - 1 && key < arr[g + LIKELY_IN_CACHE_SIZE]!) imax = g + LIKELY_IN_CACHE_SIZE;
  }
  while (imin < imax) {
    const imid = imin + ((imax - imin) >> 1);
    if (key >= arr[imid]!) imin = imid + 1;
    else imax = imid;
  }
  return imin - 1;
}

/**
 * `np.interp(xs, xp, fp)` (`arr_interp`, f64), termasuk tebakan indeks yang
 * dibawa antar-titik, kemiringan yang dihitung lebih dulu (`lenxp <= lenx`),
 * dan penanganan NaN. `xs` diproses berurutan seperti NumPy.
 */
export function npInterp(xs: ArrayLike<number>, xp: ArrayLike<number>, fp: ArrayLike<number>): Float64Array {
  const lenxp = xp.length;
  const lenx = xs.length;
  const out = new Float64Array(lenx);
  const lval = fp[0]!;
  const rval = fp[lenxp - 1]!;
  if (lenxp === 1) {
    for (let i = 0; i < lenx; i += 1) {
      const x = xs[i]!;
      out[i] = Number.isNaN(x) ? x : x < xp[0]! ? lval : x > xp[0]! ? rval : fp[0]!;
    }
    return out;
  }
  let slopes: Float64Array | undefined;
  if (lenxp <= lenx) {
    slopes = new Float64Array(lenxp - 1);
    for (let i = 0; i < lenxp - 1; i += 1) slopes[i] = (fp[i + 1]! - fp[i]!) / (xp[i + 1]! - xp[i]!);
  }
  let j = 0;
  for (let i = 0; i < lenx; i += 1) {
    const x = xs[i]!;
    if (Number.isNaN(x)) {
      out[i] = x;
      continue;
    }
    j = binarySearchWithGuess(x, xp, lenxp, j);
    if (j === -1) out[i] = lval;
    else if (j === lenxp) out[i] = rval;
    else if (j === lenxp - 1) out[i] = fp[j]!;
    else if (xp[j] === x) out[i] = fp[j]!;
    else {
      const slope = slopes ? slopes[j]! : (fp[j + 1]! - fp[j]!) / (xp[j + 1]! - xp[j]!);
      let v = slope * (x - xp[j]!) + fp[j]!;
      if (Number.isNaN(v)) {
        v = slope * (x - xp[j + 1]!) + fp[j + 1]!;
        if (Number.isNaN(v) && fp[j] === fp[j + 1]) v = fp[j]!;
      }
      out[i] = v;
    }
  }
  return out;
}

/** `np.nanmax(density_curves, axis=0)` -- max per kanal, NaN diabaikan. */
export function nanmaxPerChannel(densityCurves: ArrayLike<number>, count: number): [number, number, number] {
  const out: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let j = 0; j < count; j += 1) {
    for (let c = 0; c < 3; c += 1) {
      const v = densityCurves[j * 3 + c]!;
      if (!Number.isNaN(v) && v > out[c]!) out[c] = v;
    }
  }
  return out;
}

/**
 * Port `compute_density_curves_before_dir_couplers` (`model/couplers.py`):
 * kurva densitas sebelum efek coupler, pada grid `logExposure` yang sama.
 * `positive` (film reversal) memakai "silver density" `nanmax - d` dan
 * membalik tanda sebelum dan sesudah interpolasi.
 */
export function computeDirDensityCurvesBeforeCouplers(
  densityCurves: ArrayLike<number>,
  logExposure: ArrayLike<number>,
  matrix: ArrayLike<number>,
  positive: boolean,
  count: number,
): Float32Array {
  const silver = new Float64Array(count * 3);
  if (positive) {
    const maxPerChannel = nanmaxPerChannel(densityCurves, count);
    for (let j = 0; j < count; j += 1) {
      for (let c = 0; c < 3; c += 1) silver[j * 3 + c] = maxPerChannel[c]! - densityCurves[j * 3 + c]!;
    }
  } else {
    for (let i = 0; i < count * 3; i += 1) silver[i] = densityCurves[i]!;
  }

  const logExposure0 = new Float64Array(count * 3);
  for (let j = 0; j < count; j += 1) {
    for (let m = 0; m < 3; m += 1) {
      let acc = 0;
      for (let k = 0; k < 3; k += 1) acc += silver[j * 3 + k]! * matrix[k * 3 + m]!;
      logExposure0[j * 3 + m] = logExposure[j]! - acc;
    }
  }

  const out = new Float32Array(count * 3);
  for (let channel = 0; channel < 3; channel += 1) {
    const xp = new Float64Array(count);
    const fp = new Float64Array(count);
    for (let j = 0; j < count; j += 1) {
      xp[j] = logExposure0[j * 3 + channel]!;
      fp[j] = positive ? -densityCurves[j * 3 + channel]! : densityCurves[j * 3 + channel]!;
    }
    const y = npInterp(logExposure, xp, fp);
    for (let j = 0; j < count; j += 1) out[j * 3 + channel] = positive ? -y[j]! : y[j]!;
  }
  return out;
}

/**
 * Isi binding `dirFrame` `dir.wgsl`: 9 float matriks lalu `count * 3` kurva
 * sebelum DIR.
 */
export function dirFrameValues(
  gammas: ArrayLike<number>,
  densityCurves: ArrayLike<number>,
  logExposure: ArrayLike<number>,
  positive: boolean,
  settings: DirCouplerSettings,
): Float32Array {
  const count = logExposure.length;
  const matrix = computeDirCouplersMatrix(gammas, settings);
  const curves = computeDirDensityCurvesBeforeCouplers(densityCurves, logExposure, matrix, positive, count);
  const out = new Float32Array(9 + count * 3);
  out.set(matrix, 0);
  out.set(curves, 9);
  return out;
}
