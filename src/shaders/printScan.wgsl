// Transliterasi PARSIAL $SPEKTRAFILM_OFX/shaders/vulkan/SpektraPrintScan.comp
// (1.488 baris, 30 binding) -- Task 17. Ini BUKAN port literal shader hulu
// (yang mengimplementasikan seluruh permukaan `PrintingStage`, termasuk
// Academy Printer Density dan varian yang tidak pernah dibangkitkan
// `gen_reference.py`) melainkan port `$SPEKTRAFILM_PY/src/spektrafilm/
// runtime/stages/printing.py::PrintingStage.expose()/.develop()` -- satu
// modul WGSL, DUA entry point (`expose` menulis `log_e_print`, `develop`
// menulis `cmy_print`), persis seperti FilmExposure/CurveDevelop dipisah
// menjadi dua tahap TS meski keduanya port fungsi Python yang berdekatan.
//
// KENAPA DUA ENTRY POINT DI SATU FILE (bukan dua file): `log_e_print`
// adalah keadaan DI TENGAH `PrintingStage.expose()` Python -- ia tidak bisa
// digerbangi kalau `develop()` HARUS berjalan sebelum tap itu ditulis.
// Memisah jadi dua @compute fn di satu modul WGSL (satu file sumber, dua
// pipeline berbeda dibangun `printScan.ts`) memungkinkan gerbang
// `log_e_print` ditutup dulu, `cmy_print` menyusul -- pola yang sama
// dengan `grain.wgsl` (tiga entry point `generate`/`blurX`/`blurY`, satu
// modul, tiga pipeline).
//
// CAKUPAN gerbang `_lut` (satu-satunya yang tugas ini tutup): di bawah
// `lut_mode`, `enlarger.print_exposure=1.0`, `enlarger.diffusion_filter.active
// =False`, dan `black_white_printing_exposure_correction()==1.0` (TERBUKTI,
// bukan diasumsikan -- `scanner.white_correction`/`black_correction` KEDUANYA
// `False` di bawah `lut_mode`, dan fungsi itu `return 1.0` PERSIS ketika
// keduanya `False`, `color_reference.py:98-100`). Karena itu:
//   - `expose`: `params.slot0` HARUS 0 untuk keluarga `_lut` -- sama seperti
//     `filmExposure.wgsl`, `slot0==0u` berarti "tap ini menulis LOG langsung"
//     (tidak ada Diffusion(print) di chain, satu tahap sudah cukup), sementara
//     `slot0==1u` menyimpan raw LINEAR untuk `diffusion.wgsl` (site='print')
//     menyelesaikan `log10` akhirnya sendiri -- lih. komentar panjang di
//     `diffusion.ts`/`diffusion.wgsl` untuk gerbang debt (enlarger diffusion)
//     yang memakai cabang ini.
//   - `develop`: TIDAK ADA cabang slot -- `develop_print_morph` Python tidak
//     punya percabangan pada parameter apa pun yang gerbang ini uji
//     (`density_curves_morph.active` == False untuk SETIAP fixture, lih.
//     `src/host/spectral.ts::evaluateFittedDensity` docstring).
//
// PREFLASH TIDAK DIIMPLEMENTASIKAN (`_compute_raw_preflash` TERBUKTI no-op
// untuk `preflash_exposure<=0`, default Python, tidak pernah disentuh
// `params_builder.py`) -- lih. docstring `addPrintScanDynamicData`
// (`src/host/spectral.ts`) untuk bukti lengkap. Deklarasi cakupan, bukan
// kelalaian -- sama seperti DIR coupler positive-film branch (Task 13).
//
// ARENA (lih. `addPrintScanDynamicData`, `src/host/spectral.ts`, untuk tiap
// entri):
//   `stock` (FILM, `stockId` yang sama dipakai filmExposure/curveDevelop/dir
//   di chain yang sama): `channelDensity` (wavelengthCount x 3),
//   `baseDensity` (wavelengthCount) -- Task 17 MENAMBAHKAN kedua field ini
//   ke arena `stock` yang SUDAH ADA (bukan arena baru).
//   `dynamic`: `printLinearSensitivity` (wavelengthCount x 3, PRINT stock),
//   `printFilteredIlluminant` (wavelengthCount), `printWavelengthCount` (1),
//   `printMidgrayColorSpace` (1, dibaca host saja),
//   `printExposureCount` (1), `printCurveExposure` (printExposureCount x 2,
//   pasangan [nilai, 1/delta] SAMA bentuk dengan `curveExposure` FILM),
//   `printDensityCurvesMorphed` (printExposureCount x 3).
//
// SATU set binding modul (bukan per-entry-point): WGSL mewajibkan setiap
// pasangan (group, binding) unik di SELURUH modul, sama seperti
// `grain.wgsl` (tiga entry point, satu set 7 binding, masing-masing entry
// membaca subset-nya sendiri). `layout:'auto'` Dawn per pipeline (per
// `entryPoint`) hanya menyertakan binding yang BENAR-BENAR dijangkau entry
// itu -- `expose` menjangkau seluruh 5 di bawah (4 storage + 1 uniform),
// `develop` hanya binding 0/1/2/4 (melewati `filmStockArena`, binding 3,
// yang hanya `expose` butuh) -- jadi kedua pipeline tetap mendapat bind
// group layout minimal masing-masing, bukan superset yang tidak perlu.
@group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: CoreParams;
@group(0) @binding(3) var<storage, read> filmStockArena: array<f32>;
@group(0) @binding(4) var<storage, read> dynamicArena: array<f32>;
// Fase 2C, hanya `expose`: x = faktor midgray (`_compute_exposure_factor_midgray`,
// termasuk cabang `_comp`), y = `print_exposure * black_white_printing_exposure_correction()`.
// Dihitung host per render (`src/host/printExposure.ts`, `stages/printScan.ts`).
@group(0) @binding(5) var<uniform> printFrame: vec4<f32>;

const kLog10E: f32 = 0.4342944819032518;

fn log10Vec3(v: vec3<f32>) -> vec3<f32> {
  return log(v) * kLog10E;
}

// ============================================================================
// expose -- tap log_e_print. Port PrintingStage.expose()/_film_cmy_to_print_log_raw.
// ============================================================================

// Port `compute_density_spectral` (`model/develop.py`), satu piksel satu
// wavelength: `sum_c(cmy[c] * channel_density[wl,c]) + base_density[wl]`.
// `channelDensity`/`baseDensity` FILM stock BISA mengandung NaN pada
// beberapa (wl) -- TIDAK di-nan_to_num di sini, sama seperti Python
// (`compute_density_spectral` sendiri tidak menyaring NaN; penyaringan
// terjadi SETELAH transmittance dihitung, lih. `densityToLight` di bawah).
fn computeDensitySpectral(cmy: vec3<f32>, wl: u32) -> f32 {
  let o = ARENA_CHANNELDENSITY_OFFSET + wl * 3u;
  return cmy.r * filmStockArena[o] + cmy.g * filmStockArena[o + 1u] + cmy.b * filmStockArena[o + 2u]
    + filmStockArena[ARENA_BASEDENSITY_OFFSET + wl];
}

// Port `density_to_light` (`utils/conversions.py`): `transmitted = 10**(-density) * light`,
// lalu NaN -> 0. `transmitted != transmitted` adalah idiom standar deteksi
// NaN IEEE754 (NaN tidak pernah sama dengan dirinya sendiri) -- WGSL tidak
// punya `isnan()` yang dijamin lintas backend, idiom ini tidak bergantung
// pada fungsi bawaan apa pun.
fn densityToLight(density: f32, lightAtWavelength: f32) -> f32 {
  var transmitted = pow(10.0, -density) * lightAtWavelength;
  if (transmitted != transmitted) {
    transmitted = 0.0;
  }
  return transmitted;
}

@compute @workgroup_size(32, 8, 1)
fn expose(@builtin(global_invocation_id) gid: vec3<u32>) {
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

  let cmy = src[index];
  let wavelengthCount = u32(dynamicArena[ARENA_PRINTWAVELENGTHCOUNT_OFFSET]);

  // `_film_cmy_to_print_log_raw`: sum atas wavelength dari
  // `density_to_light(compute_density_spectral(cmy), print_illuminant)`
  // dikontraksikan terhadap `10**log_sensitivity` PRINT stock.
  var raw = vec3<f32>(0.0);
  for (var wl: u32 = 0u; wl < wavelengthCount; wl = wl + 1u) {
    let densitySpectral = computeDensitySpectral(cmy.rgb, wl);
    let illuminantAtWavelength = dynamicArena[ARENA_PRINTFILTEREDILLUMINANT_OFFSET + wl];
    let light = densityToLight(densitySpectral, illuminantAtWavelength);
    let so = ARENA_PRINTLINEARSENSITIVITY_OFFSET + wl * 3u;
    raw += light * vec3<f32>(
      dynamicArena[so], dynamicArena[so + 1u], dynamicArena[so + 2u],
    );
  }
  raw *= printFrame.x;
  // `_compute_raw_preflash` -- TIDAK diimplementasikan, TERBUKTI no-op
  // untuk setiap fixture gerbang ini (lih. komentar berkas di atas).
  let logRawPrint = log10Vec3(max(raw, vec3<f32>(0.0)) + vec3<f32>(1.0e-10));

  // `raw = 10**log_raw_print; raw *= print_exposure; raw *= black_white_printing_exposure_correction()`
  // -- keduanya digabung host-side jadi `printFrame.y` (Fase 2C; koreksi
  // hitam/putih scanner tetap 1.0, lih. `addPrintScanDynamicData`).
  let raw2 = pow(vec3<f32>(10.0), logRawPrint) * printFrame.y;

  // `apply_diffusion_filter_um(raw, enlarger.diffusion_filter, ...)` --
  // dijalankan sebagai tahap TERPISAH (`diffusion.wgsl`, site='print')
  // ketika `slot0==1u`, PERSIS pola `filmExposure.wgsl:264`/`diffusion.ts`
  // (site kamera). `slot0==0u`: tidak ada Diffusion(print) di chain
  // (`enlarger.diffusion_filter.active` mati di bawah `lut_mode`), jadi
  // tahap ini SENDIRIAN menghasilkan `log_e_print` lewat `log10` akhir di
  // sini -- sama seperti `filmExposure.wgsl`'s `slot0==0u` menghasilkan
  // `log_e_film` sendirian ketika Diffusion/Halation tidak ada di chain.
  dst[index] = select(
    vec4<f32>(log10Vec3(max(raw2, vec3<f32>(0.0)) + vec3<f32>(1.0e-10)), cmy.a),
    vec4<f32>(raw2, cmy.a),
    params.slot0 == 1u,
  );
}

// ============================================================================
// develop -- tap cmy_print. Port PrintingStage.develop()/develop_print_morph.
// ============================================================================

fn printCurveExposureValue(i: u32) -> f32 {
  return dynamicArena[ARENA_PRINTCURVEEXPOSURE_OFFSET + i * 2u];
}

fn printCurveExposureInverseDx(i: u32) -> f32 {
  return dynamicArena[ARENA_PRINTCURVEEXPOSURE_OFFSET + i * 2u + 1u];
}

fn printDensityCurveAt(i: u32, channel: u32) -> f32 {
  return dynamicArena[ARENA_PRINTDENSITYCURVESMORPHED_OFFSET + i * 3u + channel];
}

// Pencarian biner + interpolasi linear -- BENTUK SAMA dengan
// `curveDevelop.wgsl::interpDensityCurve`, TANPA cabang Hermite
// (`kColorAdaptationCurveSmoothing`) dan TANPA normalisasi push/pull:
// `develop_print_morph`/`interpolate_exposure_to_density` (dipanggil
// `apply_print_curves_morph`'s hasil, bukan `density_curves` mentah) tidak
// pernah menyentuh cabang push/pull ATAU Hermite -- keduanya milik
// `develop_simple`/`developFilmDensity` (film), bukan print. Tabel yang
// dibaca (`printDensityCurvesMorphed`) TIDAK dinormalisasi (`- nanmin`)
// seperti `densityCurves` FILM -- `develop_print_morph` Python sendiri
// tidak melakukan normalisasi itu (lih. `develop.py::develop_print_morph`,
// tidak ada `np.nanmin` di sana sama sekali).
fn interpPrintDensityCurve(logRaw: f32, channel: u32) -> f32 {
  let count = u32(dynamicArena[ARENA_PRINTEXPOSURECOUNT_OFFSET]);
  if (count == 0u) {
    return 0.0;
  }
  let firstX = printCurveExposureValue(0u);
  let lastX = printCurveExposureValue(count - 1u);
  if (logRaw <= firstX) {
    return printDensityCurveAt(0u, channel);
  }
  if (logRaw >= lastX) {
    return printDensityCurveAt(count - 1u, channel);
  }

  var lo: u32 = 0u;
  var hi: u32 = count - 1u;
  while (hi - lo > 1u) {
    let mid = (lo + hi) >> 1u;
    if (printCurveExposureValue(mid) <= logRaw) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  let x0 = printCurveExposureValue(lo);
  let inverseDx0 = printCurveExposureInverseDx(lo);
  let y0 = printDensityCurveAt(lo, channel);
  let y1 = printDensityCurveAt(hi, channel);
  let t = clamp((logRaw - x0) * inverseDx0, 0.0, 1.0);
  return mix(y0, y1, t);
}

@compute @workgroup_size(32, 8, 1)
fn develop(@builtin(global_invocation_id) gid: vec3<u32>) {
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

  let logRawPixel = src[index];
  let density = vec3<f32>(
    interpPrintDensityCurve(logRawPixel.r, 0u),
    interpPrintDensityCurve(logRawPixel.g, 1u),
    interpPrintDensityCurve(logRawPixel.b, 2u),
  );
  dst[index] = vec4<f32>(density, logRawPixel.a);
}
