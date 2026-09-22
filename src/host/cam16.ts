/**
 * Task 18 (ScannerPost): port host (JS/f64) dari CIECAM16 / CAM16-UCS
 * (Li, Li, Wang, Xu, Luo, Cui, Melgosa, Brill, Pointer 2017), dipakai murni
 * untuk MEMBANGUN tabel `C_max(Jp, h)` yang `scannerPost.wgsl` cari lewat
 * interpolasi bilinear saat runtime -- bukan untuk transform per piksel
 * (itu terjadi di WGSL, lih. `scannerPost.wgsl`).
 *
 * KENAPA port ini ada sama sekali: `_apply_cctf_encoding` Python bukan
 * langkah terakhir sebelum itu -- `_density_to_rgb` (`runtime/stages/
 * scanning.py`) memanggil `compress_rgb` (`utils/gamut_compression.py`),
 * yang default `output_gamut_compress.algorithm="cam16ucs"`
 * (`OutputGamutCompressSpec`, TIDAK di-override `tools/gen_reference.py`
 * untuk fixture manapun -- diverifikasi lewat probe host langsung,
 * lih. task-18-report.md). Diukur EMPIRIS terhadap fixture
 * `gray_ramp_lut`/`log_gray_ramp_lut`/`color_patches_lut`: mematikan
 * langkah ini mengubah `rgb_out` sampai maks abs 1.06 (color_patches) --
 * jauh di atas ambang 1e-5, BUKAN opsional untuk gerbang ini.
 *
 * `compress_rgb_cam16ucs_chroma` Python sendiri menjalankan CAM16 forward
 * DAN inverse PER PIKSEL terhadap kondisi penglihatan TETAP (`L_A=64`,
 * `Y_b=20`, surround "Average", whitepoint = whitepoint ruang warna
 * KELUARAN, `sRGB` untuk seluruh fixture gerbang ini). Karena kondisi
 * penglihatan itu TETAP (tidak bergantung piksel), transform CAM16
 * per-piksel PORTABLE ke WGSL murni (lih. `scannerPost.wgsl`) -- HANYA
 * tabel `C_max(Jp, h)` yang butuh bisection mahal terhadap kubus RGB
 * (`_build_polar_perceptual_c_max_table`, 64 x 720 x 18 langkah bisection)
 * yang di-bake DI SINI, host-side, SEBELUM `acquireDevice()` (lih. CATATAN
 * LINGKUNGAN `spectral.ts`) -- PERSIS mekanisme cache Python sendiri
 * (`_OUTPUT_CMAX_CACHE`, sekali per `(space, output_color_space)`, bukan
 * per piksel).
 *
 * Konstanta di bawah SEMUA berasal dari pembacaan langsung
 * `$SPEKTRAFILM_PY/src/spektrafilm/utils/gamut_compression.py` (viewing
 * conditions, grid, `chroma_initial_upper`) dan
 * `.venv-ref/Lib/site-packages/colour/appearance/{cam16,ciecam02}.py` +
 * `colour/models/{cam16_ucs,cam02_ucs}.py` (formula CIECAM16/UCS itu
 * sendiri, upstream `colour-science`, BUKAN spektrafilm/spektrafilm-ofx --
 * `colour` adalah dependensi Python yang sama yang dipanggil
 * `XYZ_to_CAM16UCS`/`CAM16UCS_to_XYZ`, jadi port literal formulanya
 * bukan "hulu ketiga" yang menyimpang, ia MEMANG oracle yang sama).
 */

/** Adaptation matrix M16 (CAT16), `colour.adaptation.CAT_CAT16`. */
const MATRIX_16 = [
  0.401288, 0.650173, -0.051461,
  -0.250268, 1.204414, 0.045854,
  -0.002079, 0.048952, 0.953127,
];

function invert3x3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [
    number, number, number, number, number, number, number, number, number,
  ];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);
  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;
  const det = a * A + b * B + c * C;
  return [A, D, G, B, E, H, C, F, I].map((v) => v / det);
}

const MATRIX_INVERSE_16 = invert3x3(MATRIX_16);

function matVec(m: number[], v: readonly [number, number, number]): [number, number, number] {
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
    m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
    m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
  ];
}

// Kondisi penglihatan (`_CAM16UCS_L_A`/`_CAM16UCS_Y_B`, gamut_compression.py)
// dan surround "Average" (`VIEWING_CONDITIONS_CIECAM02["Average"]`, colour).
const L_A = 64.0;
const Y_B = 20.0;
const SURROUND_F = 1.0;
const SURROUND_C = 0.69;
const SURROUND_NC = 1.0;

// Koefisien UCS Li2017 = COEFFICIENTS_UCS_LUO2006["CAM02-UCS"].
const UCS_C1 = 0.007;
const UCS_C2 = 0.0228;

const spow = (x: number, p: number): number => Math.sign(x) * Math.abs(x) ** p;

/**
 * Konstanta bergantung-whitepoint (TIDAK bergantung piksel) untuk CAM16 --
 * `D_RGB`, `F_L`, `N_bb`, `z`, `A_w` -- dihitung SEKALI dari whitepoint
 * ruang warna keluaran (XYZ, Y=1). Dipakai baik oleh pembangun tabel
 * `C_max` di sini MAUPUN oleh `scannerPost.wgsl` (nilai yang SAMA
 * di-upload sebagai konstanta arena, bukan dihitung ulang GPU -- viewing
 * conditions tetap, jadi ini murni beban precompute, bukan per-piksel).
 */
export interface Cam16ViewingConstants {
  D_RGB: [number, number, number];
  F_L: number;
  N_bb: number;
  z: number;
  A_w: number;
  n: number;
}

function postAdaptForward(rgb: readonly [number, number, number], F_L: number): [number, number, number] {
  return rgb.map((x) => {
    const t = (F_L * Math.abs(x)) / 100;
    const tp = t ** 0.42;
    return (400 * Math.sign(x) * tp) / (27.13 + tp) + 0.1;
  }) as [number, number, number];
}

function postAdaptInverse(rgb: readonly [number, number, number], F_L: number): [number, number, number] {
  // Python: `spow((27.13*|RGB-0.1|)/(400-|RGB-0.1|), 1/0.42)` -- `spow` (signed
  // power) sign-preserves the WHOLE ratio, which goes negative once
  // `|RGB-0.1| > 400` (reachable during the Cmax bisection's initial wide
  // search, `chroma_initial_upper=150`). A plain `**(1/0.42)` on a negative
  // base is NaN in JS for this fractional exponent -- found by comparing this
  // table against Python's actual `_get_output_c_max_table` output directly:
  // one cell diverged (mine 0.0 vs Python 1.73) from exactly this NaN
  // poisoning the in-gamut check for every bisection step, lih. task-18-report.md.
  return rgb.map((x) => {
    const v = Math.abs(x - 0.1);
    const s = Math.sign(x - 0.1);
    const ratio = (27.13 * v) / (400 - v);
    return ((s * 100) / F_L) * spow(ratio, 1 / 0.42);
  }) as [number, number, number];
}

const achromatic = (rgb: readonly [number, number, number], N_bb: number): number =>
  (2 * rgb[0] + rgb[1] + rgb[2] / 20 - 0.305) * N_bb;

/** `xyzUnitY` -- XYZ dengan Y=1 di whitepoint (konvensi `apply_cctf_decoding=False`). */
export function computeViewingConstants(xyzWUnitY: readonly [number, number, number]): Cam16ViewingConstants {
  const XYZ_w100: [number, number, number] = [xyzWUnitY[0] * 100, xyzWUnitY[1] * 100, xyzWUnitY[2] * 100];
  const Y_w = XYZ_w100[1];
  const n = Y_B / Y_w;

  const k = 1 / (5 * L_A + 1);
  const k4 = k ** 4;
  const F_L = 0.2 * k4 * (5 * L_A) + 0.1 * (1 - k4) ** 2 * Math.cbrt(5 * L_A);
  const N_bb = 0.725 * (1 / n) ** 0.2;
  const z = 1.48 + Math.sqrt(n);

  const D = Math.min(1, Math.max(0, SURROUND_F * (1 - (1 / 3.6) * Math.exp((-L_A - 42) / 92))));

  const RGB_w = matVec(MATRIX_16, XYZ_w100);
  const D_RGB: [number, number, number] = [
    (D * Y_w) / RGB_w[0] + (1 - D),
    (D * Y_w) / RGB_w[1] + (1 - D),
    (D * Y_w) / RGB_w[2] + (1 - D),
  ];
  const RGB_wc: [number, number, number] = [D_RGB[0] * RGB_w[0], D_RGB[1] * RGB_w[1], D_RGB[2] * RGB_w[2]];
  const RGB_aw = postAdaptForward(RGB_wc, F_L);
  const A_w = achromatic(RGB_aw, N_bb);

  return { D_RGB, F_L, N_bb, z, A_w, n };
}

/** XYZ (Y=1 unit) -> {J, M, h in degrees}. */
export function cam16Forward(
  xyzUnitY: readonly [number, number, number],
  vc: Cam16ViewingConstants,
): { J: number; M: number; hDeg: number } {
  const XYZ100: [number, number, number] = [xyzUnitY[0] * 100, xyzUnitY[1] * 100, xyzUnitY[2] * 100];
  const RGB = matVec(MATRIX_16, XYZ100);
  const RGB_c: [number, number, number] = [vc.D_RGB[0] * RGB[0], vc.D_RGB[1] * RGB[1], vc.D_RGB[2] * RGB[2]];
  const RGB_a = postAdaptForward(RGB_c, vc.F_L);
  const [Ra, Ga, Ba] = RGB_a;

  const a = Ra - (12 * Ga) / 11 + Ba / 11;
  const b = (Ra + Ga - 2 * Ba) / 9;
  const hRad = Math.atan2(b, a);
  const hDeg = ((hRad * 180) / Math.PI + 360) % 360;
  const e_t = 0.25 * (Math.cos(2 + hRad) + 3.8);

  const A = achromatic(RGB_a, vc.N_bb);
  const J = 100 * spow(A / vc.A_w, SURROUND_C * vc.z);

  const t =
    ((50000 / 13) * SURROUND_NC * vc.N_bb * e_t * Math.sqrt(a * a + b * b)) / (Ra + Ga + (21 * Ba) / 20);
  const C = spow(t, 0.9) * Math.sqrt(J / 100) * (1.64 - 0.29 ** vc.n) ** 0.73;
  const M = C * vc.F_L ** 0.25;

  return { J, M, hDeg };
}

/** {J, M, h in degrees} -> XYZ (Y=1 unit). Inverse of `cam16Forward`. */
export function cam16Inverse(
  J: number,
  M: number,
  hDeg: number,
  vc: Cam16ViewingConstants,
): [number, number, number] {
  const C = M / vc.F_L ** 0.25;
  const hRad = (hDeg * Math.PI) / 180;
  const e_t = 0.25 * (Math.cos(2 + hRad) + 3.8);
  const Jsafe = Math.max(J, 1e-9);
  const t = spow(C / (Math.sqrt(Jsafe / 100) * (1.64 - 0.29 ** vc.n) ** 0.73), 1 / 0.9);
  const A = vc.A_w * spow(J / 100, 1 / (SURROUND_C * vc.z));

  let a = 0;
  let b = 0;
  if (t !== 0) {
    const P1 = ((50000 / 13) * SURROUND_NC * vc.N_bb * e_t) / t;
    const P2 = A / vc.N_bb + 0.305;
    const P3 = 21 / 20;
    const sinH = Math.sin(hRad);
    const cosH = Math.cos(hRad);
    if (Math.abs(sinH) >= Math.abs(cosH)) {
      const n_ = P2 * (2 + P3) * (460 / 1403);
      b = n_ / (P1 / sinH + (2 + P3) * (220 / 1403) * (cosH / sinH) - 27 / 1403 + P3 * (6300 / 1403));
      a = b * (cosH / sinH);
    } else {
      const n_ = P2 * (2 + P3) * (460 / 1403);
      a = n_ / (P1 / cosH + (2 + P3) * (220 / 1403) - (27 / 1403 - P3 * (6300 / 1403)) * (sinH / cosH));
      b = a * (sinH / cosH);
    }
  }

  const P2 = A / vc.N_bb + 0.305;
  const RGB_a: [number, number, number] = [
    (460 * P2 + 451 * a + 288 * b) / 1403,
    (460 * P2 - 891 * a - 261 * b) / 1403,
    (460 * P2 - 220 * a - 6300 * b) / 1403,
  ];
  const RGB_c = postAdaptInverse(RGB_a, vc.F_L);
  const RGB: [number, number, number] = [
    RGB_c[0] / vc.D_RGB[0],
    RGB_c[1] / vc.D_RGB[1],
    RGB_c[2] / vc.D_RGB[2],
  ];
  const XYZ100 = matVec(MATRIX_INVERSE_16, RGB);
  return [XYZ100[0] / 100, XYZ100[1] / 100, XYZ100[2] / 100];
}

/** XYZ (Y=1) -> {Jp, ap, bp} (CAM16-UCS). */
export function xyzToCam16Ucs(
  xyzUnitY: readonly [number, number, number],
  vc: Cam16ViewingConstants,
): [number, number, number] {
  const { J, M, hDeg } = cam16Forward(xyzUnitY, vc);
  const Jp = ((1 + 100 * UCS_C1) * J) / (1 + UCS_C1 * J);
  const Mp = (1 / UCS_C2) * Math.log1p(UCS_C2 * M);
  const hRad = (hDeg * Math.PI) / 180;
  return [Jp, Mp * Math.cos(hRad), Mp * Math.sin(hRad)];
}

/** {Jp, ap, bp} (CAM16-UCS) -> XYZ (Y=1). Inverse of `xyzToCam16Ucs`. */
export function cam16UcsToXyz(
  Jp: number,
  ap: number,
  bp: number,
  vc: Cam16ViewingConstants,
): [number, number, number] {
  const Mp = Math.hypot(ap, bp);
  const hRad = Math.atan2(bp, ap);
  const hDeg = ((hRad * 180) / Math.PI + 360) % 360;
  const M = Math.expm1(UCS_C2 * Mp) / UCS_C2;
  const J = Jp / (1 + 100 * UCS_C1 - UCS_C1 * Jp);
  return cam16Inverse(J, M, hDeg, vc);
}

/**
 * XYZ (Y=1) whitepoint dipakai `_output_cs_whitepoint_xyz("sRGB")` Python:
 * `_xy_to_xyz_unit_y(colour.RGB_COLOURSPACES["sRGB"].whitepoint)`, whitepoint
 * D65 CIE 1931 2 derajat PERSIS `(0.31270, 0.32900)` (konstanta `colour`
 * sendiri, bukan diturunkan dari tabel apa pun).
 *
 * SENGAJA BUKAN `meterXyzToRgb^-1 @ [1,1,1]` (matriks `inputMeterXyzMatrices`
 * yang di-bake -- f32, presisi ~7 digit): ditemukan lewat pembandingan
 * langsung terhadap `colour.XYZ_to_CAM16UCS`'s `XYZ_w` argumen SUNGGUHAN
 * (`gc.compress_rgb_cam16ucs_chroma` memanggilnya dengan
 * `_output_cs_whitepoint_xyz(output_color_space)`, BUKAN matriks meter) --
 * memakai matriks f32 memberi `XYZ_w=[0.95050001,1,1.08900001]` alih-alih
 * `[0.95045593,1,1.08905775]` Python sungguhan, selisih relatif ~5e-5 yang
 * berkaskade lewat SELURUH pipeline CAM16 (D_RGB/F_L/A_w bergantung XYZ_w)
 * dan persis menjelaskan residual ~3e-5 yang diukur sebelum perbaikan ini
 * (lih. task-18-report.md). `x/y`, `1`, `(1-x-y)/y` -- `_xy_to_xyz_unit_y`.
 */
export const SRGB_WHITEPOINT_XYZ: [number, number, number] = (() => {
  const x = 0.3127;
  const y = 0.329;
  return [x / y, 1, (1 - x - y) / y];
})();

/**
 * `colour.RGB_COLOURSPACES['sRGB'].matrix_RGB_to_XYZ` -- konstanta
 * TERBIT (published, IEC 61966-2-1) yang colour-science simpan, BUKAN
 * diturunkan dari whitepoint di atas lewat perhitungan (meski secara
 * aljabar keduanya konsisten). Baris-mayor.
 */
export const SRGB_MATRIX_RGB_TO_XYZ = [
  0.4124, 0.3576, 0.1805,
  0.2126, 0.7152, 0.0722,
  0.0193, 0.1192, 0.9505,
];

/**
 * `colour.RGB_COLOURSPACES['sRGB'].matrix_XYZ_to_RGB` -- SENGAJA BUKAN
 * `invert3x3(SRGB_MATRIX_RGB_TO_XYZ)`: colour-science menyimpan KEDUA
 * matriks sebagai konstanta terbit yang DIBULATKAN SECARA INDEPENDEN
 * (masing-masing ke 4 desimal, nilai standar sRGB yang dipublikasikan),
 * BUKAN sepasang invers numerik satu sama lain. `np.linalg.inv(matrix_
 * RGB_to_XYZ)` memberi `[[3.24062548,...]]`, BUKAN `[[3.2406,...]]` --
 * selisih relatif ~1.5e-5 yang PERSIS residual yang diukur sebelum
 * perbaikan ini (lih. task-18-report.md, ditemukan lewat pembandingan
 * langsung terhadap `colour.XYZ_to_RGB(..., illuminant=white)` dan
 * `colour.RGB_to_RGB(rgb, 'sRGB', 'sRGB', apply_cctf_encoding=True)`
 * SUNGGUHAN, KEDUANYA memakai matriks terbit ini, bukan invers numerik,
 * bahkan ketika ruang sumber == ruang tujuan).
 */
export const SRGB_MATRIX_XYZ_TO_RGB = [
  3.2406, -1.5372, -0.4986,
  -0.9689, 1.8758, 0.0415,
  0.0557, -0.204, 1.057,
];

export const CMAX_TABLE_N_L = 64;
export const CMAX_TABLE_N_H = 720;
const CMAX_TABLE_N_BISECT = 18;
const CMAX_CHROMA_INITIAL_UPPER = 150.0;
const CMAX_JP_MIN = 1.0;
const CMAX_JP_MAX = 110.0;

/**
 * Bangun `C_max(Jp, h)` -- bisection PERSIS `_build_polar_perceptual_c_max_table`
 * (`space="cam16ucs"`), grid PERSIS sama (`L_grid=linspace(1,110,64)`,
 * `n_h=720`, `n_bisect=18`, `chroma_initial_upper=150`) supaya bisection di
 * sini konvergen ke nilai yang SAMA (bukan cuma dekat) dengan yang Python
 * bangun saat membangkitkan fixture -- deterministik, sama-sama float64,
 * sama-sama fungsi in-gamut yang identik (`meterXyzToRgb` DI-BAKE Python,
 * byte-identik, bukan ditranskripsi ulang).
 *
 * Memakai `SRGB_MATRIX_XYZ_TO_RGB` (konstanta terbit, BUKAN invers numerik
 * -- lih. docstring di atas untuk kenapa itu penting persis di sini juga:
 * uji in-gamut bisection ini yang menentukan seluruh bentuk tabel).
 */
export function buildCam16UcsGamutTable(vc: Cam16ViewingConstants): Float32Array {
  const table = new Float32Array(CMAX_TABLE_N_L * CMAX_TABLE_N_H);
  const hStep = (2 * Math.PI) / CMAX_TABLE_N_H;
  for (let li = 0; li < CMAX_TABLE_N_L; li += 1) {
    const Jp = CMAX_JP_MIN + ((CMAX_JP_MAX - CMAX_JP_MIN) * li) / (CMAX_TABLE_N_L - 1);
    for (let hi = 0; hi < CMAX_TABLE_N_H; hi += 1) {
      const h = -Math.PI + hi * hStep;
      const cosH = Math.cos(h);
      const sinH = Math.sin(h);
      let lo = 0;
      let hi_ = CMAX_CHROMA_INITIAL_UPPER;
      for (let step = 0; step < CMAX_TABLE_N_BISECT; step += 1) {
        const mid = (lo + hi_) * 0.5;
        const xyz = cam16UcsToXyz(Jp, mid * cosH, mid * sinH, vc);
        const rgb = matVec(SRGB_MATRIX_XYZ_TO_RGB, xyz);
        const inGamut = rgb.every((v) => v >= -1e-6 && v <= 1 + 1e-6);
        if (inGamut) lo = mid;
        else hi_ = mid;
      }
      table[li * CMAX_TABLE_N_H + hi] = lo;
    }
  }
  return table;
}

/**
 * Semua konstanta + tabel yang `scannerPost.wgsl` butuhkan untuk
 * `compress_rgb` (CAM16-UCS, `output_color_space="sRGB"`), dibangun SEKALI
 * host-side SEBELUM `acquireDevice()` (lih. CATATAN LINGKUNGAN
 * `spectral.ts`) -- `buildCam16UcsGamutTable` sendiri menjalankan
 * 64*720*18 ≈ 830rb evaluasi `cam16UcsToXyz`, beban CPU yang SAMA
 * jenisnya dengan precompute lain di modul ini (mis. `hanatosRawResponse`),
 * bukan sesuatu yang aman dijalankan setelah device hidup.
 */
export interface ScannerCam16Static {
  viewing: Cam16ViewingConstants;
  cmaxTable: Float32Array;
}

export function buildScannerCam16Static(): ScannerCam16Static {
  const viewing = computeViewingConstants(SRGB_WHITEPOINT_XYZ);
  const cmaxTable = buildCam16UcsGamutTable(viewing);
  return { viewing, cmaxTable };
}
