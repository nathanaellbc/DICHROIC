// Task 18: transliterasi `ScanningStage.scan()` Python
// (`$SPEKTRAFILM_PY/src/spektrafilm/runtime/stages/scanning.py:46-50`),
// tap `rgb_out` -- `_density_to_rgb` (cabang `io.scan_film=False`, mencetak
// PRINT) -> `_apply_blur_and_unsharp` -> `_apply_cctf_encoding`.
//
// CAKUPAN gerbang `_lut` (satu-satunya yang berkas ini tutup langsung; lih.
// `addScannerPostDynamicData`, `src/host/spectral.ts`, untuk bukti penuh
// per istilah): di bawah `lut_mode`, glare (stokastik) mati, `scanner.
// lens_blur=0` (sudah nol bahkan di default), `scanner.unsharp_mask=(0,0)`,
// dan `white_correction`/`black_correction` KEDUANYA `False` -- jadi satu
// dispatch cukup: `density -> XYZ (spektral) -> RGB linear (scanToOutputRgb)
// -> compress_rgb (CAM16-UCS) -> CCTF encode (analitik sRGB)`.
//
// `compress_rgb` (`utils/gamut_compression.py`, `output_gamut_compress.
// algorithm="cam16ucs"` DEFAULT Python, TIDAK PERNAH di-override
// `tools/gen_reference.py`) BUKAN opsional -- diukur langsung: mematikannya
// mengubah `rgb_out` sampai maks abs 1.06 (`color_patches_lut`), 5 ORDE di
// atas ambang 1e-5. Port CIECAM16/CAM16-UCS (Li, Li, Wang, Xu, Luo, Cui,
// Melgosa, Brill, Pointer 2017) PERSIS `.venv-ref/Lib/site-packages/colour/
// appearance/{cam16,ciecam02}.py` + `colour/models/{cam16_ucs,cam02_ucs}.py`
// -- lih. `src/host/cam16.ts` untuk turunan rumus lengkap DAN tiga bug yang
// ditemukan lewat pembandingan langsung terhadap nilai internal Python
// SUNGGUHAN (bukan cuma dibaca dari kode), semuanya berlaku SAMA di sini:
//   1. Whitepoint adaptasi CAM16 (`XYZ_w`) HARUS diturunkan dari xy D65
//      EKSAK `(0.3127, 0.3290)`, BUKAN dari matriks meter yang di-bake
//      (presisi f32) -- selisih relatif ~5e-5 kalau tertukar.
//   2. `postAdaptInverse` HARUS pakai signed-power (`spow`, tanda
//      dipertahankan): basis `(27.13*|RGB-0.1|)/(400-|RGB-0.1|)` bisa
//      negatif untuk RGB besar (dijangkau tabel Cmax, chroma awal 150) --
//      power pecahan atas basis negatif adalah NaN kalau tidak dijaga.
//   3. Matriks `XYZ<->RGB` sRGB yang Python PAKAI (baik untuk XYZ<->RGB
//      "meter" MAUPUN untuk roundtrip implisit `_apply_cctf_encoding`)
//      adalah KONSTANTA TERBIT (`colour.RGB_COLOURSPACES['sRGB'].matrix_
//      XYZ_to_RGB`), BUKAN invers numerik `matrix_RGB_to_XYZ` -- keduanya
//      DIBULATKAN SECARA INDEPENDEN ke 4 desimal, bukan sepasang invers.
//      `_apply_cctf_encoding` Python (`colour.RGB_to_RGB(rgb, cs, cs,
//      apply_cctf_decoding=False, apply_cctf_encoding=True)`) diam-diam
//      melakukan roundtrip RGB->XYZ->RGB lewat KEDUA matriks itu SEBELUM
//      encode -- BUKAN identitas persis untuk source==dest space, dan
//      HARUS direplikasi (diverifikasi cocok ~5e-8 setelah ditambahkan,
//      task-18-report.md).
//
// ARENA (lih. `addScannerPostDynamicData`, `src/host/spectral.ts`):
//   `static`  -- `standardObserverCmfs` (wavelengthCount x 3).
//   `dynamic` -- `scannerChannelDensity`/`scannerBaseDensity` (PRINT,
//   wavelengthCount x {3,1}), `scannerIlluminant` (wavelengthCount),
//   `scannerWavelengthCount`/`scannerNormalization` (skalar),
//   `scannerToOutputRgb` (3x3, `sRGB`), `scannerCam16Viewing` (8 skalar:
//   D_RGB.xyz, F_L, N_bb, z, A_w, n), `scannerCam16CmaxTable` (64x720,
//   `C_max(Jp,h)`, dibangun host `buildCam16UcsGamutTable`).
@group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: CoreParams;
@group(0) @binding(3) var<storage, read> staticArena: array<f32>;
@group(0) @binding(4) var<storage, read> dynamicArena: array<f32>;

const kLog10E: f32 = 0.4342944819032518;

// ============================================================================
// density -> XYZ spektral (`cmy_to_log_xyz`, `compute_density_spectral` +
// `density_to_light`, port sama seperti `printScan.wgsl`, arena berbeda).
// ============================================================================

fn computeDensitySpectral(cmy: vec3<f32>, wl: u32) -> f32 {
  let o = ARENA_SCANNERCHANNELDENSITY_OFFSET + wl * 3u;
  return cmy.r * dynamicArena[o] + cmy.g * dynamicArena[o + 1u] + cmy.b * dynamicArena[o + 2u]
    + dynamicArena[ARENA_SCANNERBASEDENSITY_OFFSET + wl];
}

fn densityToLight(density: f32, lightAtWavelength: f32) -> f32 {
  var transmitted = pow(10.0, -density) * lightAtWavelength;
  if (transmitted != transmitted) {
    transmitted = 0.0;
  }
  return transmitted;
}

// `cmy_to_log_xyz` lalu `10**log_xyz` di `_density_to_rgb` adalah roundtrip
// log10/pow10 identitas murni atas nilai yang sudah `fmax(.,0)+1e-10`
// (selalu > 0) -- disederhanakan aljabar di sini (bukan tafsir ulang,
// `10**log10(y) == y` untuk `y>0`), yang juga MENGHINDARI galat pow10/log10
// f32 (~1e-7) yang roundtrip literal akan tambahkan tanpa alasan numerik.
fn densityToXyz(cmy: vec3<f32>) -> vec3<f32> {
  let wavelengthCount = u32(dynamicArena[ARENA_SCANNERWAVELENGTHCOUNT_OFFSET]);
  var xyzSum = vec3<f32>(0.0);
  for (var wl: u32 = 0u; wl < wavelengthCount; wl = wl + 1u) {
    let densitySpectral = computeDensitySpectral(cmy, wl);
    let illuminantAtWavelength = dynamicArena[ARENA_SCANNERILLUMINANT_OFFSET + wl];
    let light = densityToLight(densitySpectral, illuminantAtWavelength);
    let co = wl * 3u;
    xyzSum += light * vec3<f32>(
      staticArena[ARENA_STANDARDOBSERVERCMFS_OFFSET + co],
      staticArena[ARENA_STANDARDOBSERVERCMFS_OFFSET + co + 1u],
      staticArena[ARENA_STANDARDOBSERVERCMFS_OFFSET + co + 2u],
    );
  }
  let normalization = dynamicArena[ARENA_SCANNERNORMALIZATION_OFFSET];
  let xyz = xyzSum / normalization;
  return max(xyz, vec3<f32>(0.0)) + vec3<f32>(1.0e-10);
}

fn scanToOutputRgb(xyz: vec3<f32>) -> vec3<f32> {
  let o = ARENA_SCANNERTOOUTPUTRGB_OFFSET;
  let m = mat3x3<f32>(
    dynamicArena[o], dynamicArena[o + 3u], dynamicArena[o + 6u],
    dynamicArena[o + 1u], dynamicArena[o + 4u], dynamicArena[o + 7u],
    dynamicArena[o + 2u], dynamicArena[o + 5u], dynamicArena[o + 8u],
  );
  return m * xyz;
}

// ============================================================================
// CAM16 / CAM16-UCS -- port `src/host/cam16.ts`, lih. blok komentar berkas
// untuk turunan rumus dan tiga bug yang ditemukan (whitepoint, signed-power,
// matriks terbit vs invers numerik). `spow` = "signed power": tanda basis
// dipertahankan sebelum dipangkatkan -- WGSL `pow()` TIDAK menjamin ini
// untuk basis negatif dan eksponen pecahan (bisa NaN), jadi SETIAP pow()
// pada nilai yang bisa negatif di bawah ini memakai `spow`, bukan `pow`.
// ============================================================================

fn spow(x: f32, p: f32) -> f32 {
  return sign(x) * pow(abs(x), p);
}

// `atan2()` GPU (Dawn/Tint, backend native) DIUKUR menyimpang 20-96 ULP dari
// nilai bulat-benar (~1e-6 sampai ~1.1e-5 RADIAN absolut) pada masukan biasa
// (bukan kasus tepi) -- probe langsung terhadap device SUNGGUHAN, dibandingkan
// `Math.atan2` f64 yang di-downcast f32, lih. task-18-report.md. WGSL HANYA
// menjamin `atan2` akurat sampai 4096 ULP (spesifikasi §15.9), jadi ini bukan
// bug driver, ia MEMANG dalam kontrak -- tapi `hp = atan2(jab.z, jab.y)`
// (`compressRgbCam16Ucs`) punya penguatan HAMPIR SATU (diukur ~0.81 lewat
// analisis sensitivitas host f64: menyuntik satu galat di `hp` propagasi
// ~81%-nya langsung ke `rgb_out`) ke arah CpMax (tabel gamut, sangat
// nonlinier dekat siku knee) DAN rekonstruksi `ap`/`bp` -- SATU-SATUNYA
// sumber yang teridentifikasi cukup besar untuk menjelaskan residual 1.6e-5
// `color_patches_lut` (Gate A). Polinomial minimax (least-squares, derajat
// 7 dalam x^2, `fit_atan.mjs`) di bawah terverifikasi <2.9e-7 rad di SELURUH
// domain (2 juta sampel acak + kasus tepi sumbu/kuadran) -- >40x lebih akurat
// dari `atan2()` native yang diukur, dan HANYA memakai perkalian-tambah
// (tanpa transcendental GPU tambahan selain SATU pemanggilan di dalam
// `atanPoly`, yang derajat rendahnya sendiri tidak mewarisi galat approksimasi
// hardware manapun karena TIDAK memanggil `atan`/`atan2` bawaan sama sekali).
fn atanPoly(x: f32) -> f32 {
  let t = x * x;
  var p = -0.005021098775;
  p = p * t + 0.02533179913;
  p = p * t - 0.06087458420;
  p = p * t + 0.1000220994;
  p = p * t - 0.1404782205;
  p = p * t + 0.1997402856;
  p = p * t - 0.3333223261;
  p = p * t + 0.9999999228;
  return x * p;
}

fn atan2Accurate(y: f32, x: f32) -> f32 {
  let ax = abs(x);
  let ay = abs(y);
  let mn = min(ax, ay);
  let mx = max(ax, ay);
  let r = select(mn / mx, 0.0, mx == 0.0);
  var angle = atanPoly(r);
  if (ay > ax) {
    angle = 1.5707963267948966 - angle;
  }
  if (x < 0.0) {
    angle = 3.14159265358979 - angle;
  }
  if (y < 0.0) {
    angle = -angle;
  }
  return angle;
}

const kMatrix16 = mat3x3<f32>(
  0.401288, -0.250268, -0.002079,
  0.650173, 1.204414, 0.048952,
  -0.051461, 0.045854, 0.953127,
);
const kMatrixInverse16 = mat3x3<f32>(
  1.86206786, 0.38752654, -0.0158415,
  -1.01125463, 0.62144744, -0.03412294,
  0.14918678, -0.00897399, 1.04996444,
);
// `colour.RGB_COLOURSPACES['sRGB'].matrix_RGB_to_XYZ`/`matrix_XYZ_to_RGB`
// -- konstanta TERBIT independen, BUKAN sepasang invers (lih. blok komentar
// berkas). WGSL `mat3x3` kolom-mayor: baris matriks Python jadi KOLOM di
// sini (pola sama dengan `kMatrix16` di atas).
const kSrgbRgbToXyz = mat3x3<f32>(
  0.4124, 0.2126, 0.0193,
  0.3576, 0.7152, 0.1192,
  0.1805, 0.0722, 0.9505,
);
const kSrgbXyzToRgb = mat3x3<f32>(
  3.2406, -0.9689, 0.0557,
  -1.5372, 1.8758, -0.2040,
  -0.4986, 0.0415, 1.0570,
);

const kSurroundC: f32 = 0.69;
const kSurroundNc: f32 = 1.0;
const kUcsC1: f32 = 0.007;
const kUcsC2: f32 = 0.0228;

struct Cam16Viewing {
  D_RGB: vec3<f32>,
  F_L: f32,
  N_bb: f32,
  z: f32,
  A_w: f32,
  n: f32,
}

fn loadCam16Viewing() -> Cam16Viewing {
  let o = ARENA_SCANNERCAM16VIEWING_OFFSET;
  var vc: Cam16Viewing;
  vc.D_RGB = vec3<f32>(dynamicArena[o], dynamicArena[o + 1u], dynamicArena[o + 2u]);
  vc.F_L = dynamicArena[o + 3u];
  vc.N_bb = dynamicArena[o + 4u];
  vc.z = dynamicArena[o + 5u];
  vc.A_w = dynamicArena[o + 6u];
  vc.n = dynamicArena[o + 7u];
  return vc;
}

fn postAdaptForward(rgb: vec3<f32>, F_L: f32) -> vec3<f32> {
  let t = pow((F_L * abs(rgb)) / 100.0, vec3<f32>(0.42));
  return (400.0 * sign(rgb) * t) / (27.13 + t) + 0.1;
}

fn postAdaptInverse(rgb: vec3<f32>, F_L: f32) -> vec3<f32> {
  let v = abs(rgb - vec3<f32>(0.1));
  let s = sign(rgb - vec3<f32>(0.1));
  let ratio = (27.13 * v) / (400.0 - v);
  return ((s * 100.0) / F_L) * vec3<f32>(spow(ratio.x, 1.0 / 0.42), spow(ratio.y, 1.0 / 0.42), spow(ratio.z, 1.0 / 0.42));
}

fn achromatic(rgb: vec3<f32>, N_bb: f32) -> f32 {
  return (2.0 * rgb.x + rgb.y + rgb.z / 20.0 - 0.305) * N_bb;
}

struct Cam16Fwd { J: f32, M: f32, hDeg: f32 }

fn cam16Forward(xyzUnitY: vec3<f32>, vc: Cam16Viewing) -> Cam16Fwd {
  let XYZ100 = xyzUnitY * 100.0;
  let RGB = kMatrix16 * XYZ100;
  let RGB_c = vc.D_RGB * RGB;
  let RGB_a = postAdaptForward(RGB_c, vc.F_L);
  let a = RGB_a.x - (12.0 * RGB_a.y) / 11.0 + RGB_a.z / 11.0;
  let b = (RGB_a.x + RGB_a.y - 2.0 * RGB_a.z) / 9.0;
  let hRad = atan2Accurate(b, a);
  var hDeg = (hRad * 180.0 / 3.14159265358979) ;
  hDeg = hDeg - 360.0 * floor(hDeg / 360.0);
  let e_t = 0.25 * (cos(2.0 + hRad) + 3.8);
  let A = achromatic(RGB_a, vc.N_bb);
  let J = 100.0 * spow(A / vc.A_w, kSurroundC * vc.z);
  let t = ((50000.0 / 13.0) * kSurroundNc * vc.N_bb * e_t * sqrt(a * a + b * b))
    / (RGB_a.x + RGB_a.y + (21.0 * RGB_a.z) / 20.0);
  let C = spow(t, 0.9) * sqrt(J / 100.0) * pow(1.64 - pow(0.29, vc.n), 0.73);
  let M = C * pow(vc.F_L, 0.25);
  var out: Cam16Fwd;
  out.J = J; out.M = M; out.hDeg = hDeg;
  return out;
}

fn cam16Inverse(J: f32, M: f32, hDeg: f32, vc: Cam16Viewing) -> vec3<f32> {
  let C = M / pow(vc.F_L, 0.25);
  let hRad = hDeg * 3.14159265358979 / 180.0;
  let e_t = 0.25 * (cos(2.0 + hRad) + 3.8);
  let Jsafe = max(J, 1.0e-9);
  let t = spow(C / (sqrt(Jsafe / 100.0) * pow(1.64 - pow(0.29, vc.n), 0.73)), 1.0 / 0.9);
  let A = vc.A_w * spow(J / 100.0, 1.0 / (kSurroundC * vc.z));
  let P2 = A / vc.N_bb + 0.305;

  var a = 0.0;
  var b = 0.0;
  if (t != 0.0) {
    let P1 = ((50000.0 / 13.0) * kSurroundNc * vc.N_bb * e_t) / t;
    let P3 = 21.0 / 20.0;
    let sinH = sin(hRad);
    let cosH = cos(hRad);
    let n_ = P2 * (2.0 + P3) * (460.0 / 1403.0);
    if (abs(sinH) >= abs(cosH)) {
      b = n_ / (P1 / sinH + (2.0 + P3) * (220.0 / 1403.0) * (cosH / sinH) - 27.0 / 1403.0 + P3 * (6300.0 / 1403.0));
      a = b * (cosH / sinH);
    } else {
      a = n_ / (P1 / cosH + (2.0 + P3) * (220.0 / 1403.0) - (27.0 / 1403.0 - P3 * (6300.0 / 1403.0)) * (sinH / cosH));
      b = a * (sinH / cosH);
    }
  }

  let RGB_a = vec3<f32>(
    (460.0 * P2 + 451.0 * a + 288.0 * b) / 1403.0,
    (460.0 * P2 - 891.0 * a - 261.0 * b) / 1403.0,
    (460.0 * P2 - 220.0 * a - 6300.0 * b) / 1403.0,
  );
  let RGB_c = postAdaptInverse(RGB_a, vc.F_L);
  let RGB = RGB_c / vc.D_RGB;
  let XYZ100 = kMatrixInverse16 * RGB;
  return XYZ100 / 100.0;
}

fn xyzToCam16Ucs(xyzUnitY: vec3<f32>, vc: Cam16Viewing) -> vec3<f32> {
  let fwd = cam16Forward(xyzUnitY, vc);
  let Jp = ((1.0 + 100.0 * kUcsC1) * fwd.J) / (1.0 + kUcsC1 * fwd.J);
  let Mp = (1.0 / kUcsC2) * log(1.0 + kUcsC2 * fwd.M);
  let hRad = fwd.hDeg * 3.14159265358979 / 180.0;
  return vec3<f32>(Jp, Mp * cos(hRad), Mp * sin(hRad));
}

// `np.expm1(x) = exp(x)-1` tapi TANPA pembatalan katastrofik untuk `x`
// kecil (persis kasus kroma rendah/akromatik, common pada `color_patches`
// -- ditemukan sebagai penyebab galat GPU ~1.6e-5 di `color_patches_lut`,
// 1.6x ambang, sebelum perbaikan ini): `exp(x)-1` di f32 kehilangan
// presisi relatif untuk `x` mendekati 0 (`exp(x)` mendekati 1, selisihnya
// jauh lebih kecil dari presisi representasi `exp(x)` itu sendiri). Deret
// Taylor `x + x^2/2! + x^3/3! + x^4/4!` dipakai untuk `|x| < 1e-2` (radius
// cukup kecil sehingga suku ke-5 dst berada di bawah presisi f32).
fn expm1Stable(x: f32) -> f32 {
  if (abs(x) < 1.0e-2) {
    return x * (1.0 + x * (0.5 + x * (1.0 / 6.0 + x * (1.0 / 24.0))));
  }
  return exp(x) - 1.0;
}

fn cam16UcsToXyz(Jp: f32, ap: f32, bp: f32, vc: Cam16Viewing) -> vec3<f32> {
  let Mp = sqrt(ap * ap + bp * bp);
  let hRad = atan2Accurate(bp, ap);
  var hDeg = hRad * 180.0 / 3.14159265358979;
  hDeg = hDeg - 360.0 * floor(hDeg / 360.0);
  let M = expm1Stable(kUcsC2 * Mp) / kUcsC2;
  let J = Jp / (1.0 + 100.0 * kUcsC1 - kUcsC1 * Jp);
  return cam16Inverse(J, M, hDeg, vc);
}

fn reinhardKnee(d: f32, threshold: f32, limit: f32, power: f32) -> f32 {
  if (d <= threshold) {
    return d;
  }
  let scale = limit - threshold;
  let x = (d - threshold) / scale;
  let y = x / pow(1.0 + pow(x, power), 1.0 / power);
  return threshold + scale * y;
}

fn cmaxLookup(Jp: f32, h: f32) -> f32 {
  let nL = 64u;
  let nH = 720u;
  let lMin = 1.0;
  let lMax = 110.0;
  let Jc = clamp(Jp, lMin, lMax);
  let hStep = (2.0 * 3.14159265358979) / f32(nH);
  var hIdx = (h - (-3.14159265358979)) / hStep;
  hIdx = hIdx - f32(nH) * floor(hIdx / f32(nH));
  let hLo = u32(floor(hIdx)) % nH;
  let hHi = (hLo + 1u) % nH;
  let hFrac = hIdx - floor(hIdx);

  let lIdx = (Jc - lMin) / (lMax - lMin) * f32(nL - 1u);
  let lLo = min(u32(floor(lIdx)), nL - 2u);
  let lHi = lLo + 1u;
  let lFrac = lIdx - f32(lLo);

  let o = ARENA_SCANNERCAM16CMAXTABLE_OFFSET;
  let v00 = dynamicArena[o + lLo * nH + hLo];
  let v01 = dynamicArena[o + lLo * nH + hHi];
  let v10 = dynamicArena[o + lHi * nH + hLo];
  let v11 = dynamicArena[o + lHi * nH + hHi];
  return v00 * (1.0 - lFrac) * (1.0 - hFrac) + v01 * (1.0 - lFrac) * hFrac
    + v10 * lFrac * (1.0 - hFrac) + v11 * lFrac * hFrac;
}

// `compress_rgb_cam16ucs_chroma` (`utils/gamut_compression.py`), knee
// `threshold=0, limit=1, power=6`, `lightness_compression=(0.7,1.0,2.2)`
// -- KEDUANYA konstanta terkunci Python, DIBUKTIKAN lewat pembacaan
// `OutputGamutCompressSpec` default dan probe host langsung (kwargs
// SUNGGUHAN yang `compress_rgb` teruskan), bukan ditebak.
fn compressRgbCam16Ucs(rgbLinear: vec3<f32>, vc: Cam16Viewing) -> vec3<f32> {
  let xyz = kSrgbRgbToXyz * rgbLinear;
  var jab = xyzToCam16Ucs(xyz, vc);
  // `_compress_lightness`: knee satu-sisi pada Jp, dinormalisasi `L_white`
  // -- `_cam16ucs_white_Jp` TERBUKTI ALJABAR persis 100.0 untuk SEMBARANG
  // koefisien UCS (Jp=(1+100c1)*J/(1+c1*J) pada J=100 selalu 100), jadi
  // konstanta di sini, bukan dihitung ulang (lih. `src/host/cam16.ts`).
  jab.x = 100.0 * reinhardKnee(jab.x / 100.0, 0.7, 1.0, 2.2);

  let Cp = sqrt(jab.y * jab.y + jab.z * jab.z);
  let hp = atan2Accurate(jab.z, jab.y);
  let CpMax = max(cmaxLookup(jab.x, hp), 1.0e-9);
  let d = reinhardKnee(Cp / CpMax, 0.0, 1.0, 6.0);
  let CpNew = d * CpMax;
  let apNew = CpNew * cos(hp);
  let bpNew = CpNew * sin(hp);

  let xyzNew = cam16UcsToXyz(jab.x, apNew, bpNew, vc);
  return kSrgbXyzToRgb * xyzNew;
}

// `_apply_cctf_encoding` (`colour.RGB_to_RGB(rgb, cs, cs,
// apply_cctf_decoding=False, apply_cctf_encoding=True)`) diam-diam
// roundtrip RGB->XYZ->RGB lewat KEDUA matriks terbit sebelum encode --
// lih. blok komentar berkas (poin 3) untuk bukti numerik penuh.
fn srgbEncode(v: f32) -> f32 {
  if (v <= 0.0031308) {
    return 12.92 * v;
  }
  return 1.055 * spow(v, 1.0 / 2.4) - 0.055;
}

fn applyCctfEncoding(rgbCompressed: vec3<f32>) -> vec3<f32> {
  let xyz = kSrgbRgbToXyz * rgbCompressed;
  let rgb2 = kSrgbXyzToRgb * xyz;
  return vec3<f32>(srgbEncode(rgb2.x), srgbEncode(rgb2.y), srgbEncode(rgb2.z));
}

@compute @workgroup_size(32, 8, 1)
fn scan(@builtin(global_invocation_id) gid: vec3<u32>) {
  let activeWidth = select(params.width, params.activeWidth, params.activeWidth != 0u);
  let activeHeight = select(params.height, params.activeHeight, params.activeHeight != 0u);
  if (gid.x >= activeWidth || gid.y >= activeHeight) {
    return;
  }
  let absoluteGid = gid.xy + vec2<u32>(params.activeOriginX, params.activeOriginY);
  if (absoluteGid.x >= params.width || absoluteGid.y >= params.height) {
    return;
  }
  let index = absoluteGid.y * params.width + absoluteGid.x;

  let cmyPrint = src[index];
  let xyz = densityToXyz(cmyPrint.rgb);
  // `black_white_xyz_correction`: identitas (`white_correction`/
  // `black_correction` KEDUANYA `False`, lih. blok komentar berkas).
  let rgbLinear = scanToOutputRgb(xyz);
  // `add_glare`: TIDAK diimplementasikan (stokastik, mati di bawah
  // `lut_mode`/gerbang ini -- lih. blok komentar berkas).

  let vc = loadCam16Viewing();
  let rgbCompressed = compressRgbCam16Ucs(rgbLinear, vc);

  // `_apply_blur_and_unsharp`: TIDAK diimplementasikan -- TERBUKTI no-op
  // untuk gerbang ini (lih. blok komentar berkas).
  let rgbEncoded = applyCctfEncoding(rgbCompressed);

  dst[index] = vec4<f32>(rgbEncoded, cmyPrint.a);
}
