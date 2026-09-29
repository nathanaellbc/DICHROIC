// Transliterasi `SpektraDir.comp` (Task 13) + difusi spasial dua-skala DIR
// couplers (Task 18c). Menutup gerbang `cmy_film` (Task 13) DAN lubang
// cakupan §6.5.2 (task-18c-report.md): keluarga `<case>` BIASA (family
// `'measured'`, BUKAN `_lut`, BUKAN `*_diffusion_print`) TIDAK menolkan
// `dir_couplers.diffusion_size_um` (default Python `20.0`, spasial) --
// hanya `lut_mode` dan fixture `*_diffusion_print` (Task 17, sengaja,
// lih. `tools/gen_reference.py::_build_params_diffusion_print`)
// menolkannya. Task 13 (lih. draf lama berkas ini) HANYA mengimplementasikan
// cabang non-spasial dan mendokumentasikan spasial sebagai "ditunda,
// diverifikasi kelak terhadap keluarga yang efeknya hidup" -- gerbang
// deterministik baru `measuredChain.test.ts` (Task 18c) di `cmy_film` untuk
// keluarga `measured` BIASA adalah keluarga fixture pertama itu, dan ia
// memerahkan tepat di sini (`log_gray_ramp`, 1.227e-4 vs ambang 1e-5) --
// dibuktikan LANGSUNG dari `tools/gen_reference.py::_build_params` (TIDAK
// menolkan `diffusion_size_um`), `model/couplers.py::
// apply_density_correction_dir_couplers` (short-circuit `if
// diffusion_size_pixel>0`), dan pengukuran host f64 langsung terhadap
// `.venv-ref` (task-18c-report.md): untuk fixture 32x16/8x8 ini
// `diffusion_size_pixel` (~0.018-0.005) MEMANG membuat komponen Gaussian
// DASAR identik radius-0 (identitas, TIDAK berubah dari draf lama), tapi
// EKOR eksponensial `fast_exponential_filter` (dipakai `diffusion_tail_um`
// via `diffusion_tail_size_pixel`, tiga komponen campuran-Gaussian) punya
// DUA dari tiga komponen dengan radius bukan-nol (1 dan 2 piksel) untuk
// gray_ramp/log_gray_ramp -- bobot campurannya kecil (`diffusion_tail_
// weight=0.06`) tapi TIDAK NOL, dan cukup untuk memerahkan gerbang 1e-5
// pada gambar dengan gradien lokal tajam (log ramp).
//
// PERBAIKAN (Task 18c): kedua suku spasial `compute_exposure_correction_
// dir_couplers` sekarang diport PENUH --
//   log_raw_correction = (1-diffusion_tail_weight) * fast_gaussian_filter(raw_correction, diffusion_size_pixel)
//                       +    diffusion_tail_weight  * fast_exponential_filter(raw_correction, diffusion_tail_size_pixel)
// -- lewat arsitektur multi-dispatch (kOp* di bawah), PERSIS pola
// `halation.wgsl` (Task 14): korelasi/kernel dihitung SEKALI per-run di
// host (`dir.ts`, JS/f64, PERSIS `_gaussian_kernel_1d` Python: radius =
// int(truncate*sigma+0.5), truncate=3.0 default `fast_gaussian_filter`/
// `fast_exponential_filter`, bobot exp(-0.5*(x/sigma)^2) dinormalisasi ke
// total=1) dan diunggah sebagai tabel bobot KONKRET (bukan dihitung ulang
// via `exp()` WGSL per piksel) -- SENGAJA, bukan demi performa: Gate A
// (task-18-report.md) mengukur `atan2()` WGSL 20-96 ULP dari correctly-
// rounded pada backend ini, jauh di dalam kontrak spec tapi jauh dari
// "f32 hanya bising di 1e-7". Menghindari transcendental WGSL untuk bobot
// kernel yang GLOBAL KONSTAN per-render (tidak bergantung piksel) meniadakan
// risiko yang sama sepenuhnya, bukan cuma menguranginya -- kernelnya sendiri
// PERSIS bit yang akan dihasilkan `_gaussian_kernel_1d` Python (f64, lalu
// diturunkan ke f32 saat diunggah), bukan aproksimasi baru.
//
// KONSTANTA HARDCODE, DIBUKTIKAN BUKAN DITEBAK (lih. task-18c-report.md):
// `diffusion_size_um=20.0`/`diffusion_tail_um=200.0`/`diffusion_tail_
// weight=0.06` (`DirCouplersParams`, params_schema.py) TIDAK PERNAH
// disentuh preset stock manapun di `params_builder.py` (hanya
// `gamma_samelayer_rgb`/`gamma_interlayer_*`, yang SUDAH dibakukan ke
// `dirCouplersMatrix` arena sejak Task 13, berubah per stock) -- SAMA
// polanya dengan konstanta `halation.wgsl` (lih. blok komentar di sana).
// `film_format_mm=35.0` (`pixel_size_um = film_format_mm*1000/max(width,
// height)`, `ResizingService.pixel_size_um`) juga sudah dibakukan identik
// oleh `halation.ts`/`diffusion.ts` (Task 14/15/17) -- dipakai ulang di sini
// (`dir.ts`), bukan diketik ulang tanpa verifikasi.
//
// BLUR DIFUSI (Fase 2A.5): `(1-w)*G(size_px) + w*Exp(tail_px)` pada koreksi
// log-raw kini dijalankan `dir.ts` lewat primitif bersama `GaussianBlur`
// (`gaussian.wgsl`, port `fast_gaussian_filter` termasuk IIR Young-van Vliet
// untuk sigma >= 3 px dan reflect scipy untuk FIR). Dulu berkas ini membawa
// FIR sendiri (radius maks 16) yang sengaja tidak mencakup rezim IIR; di
// 6 um/px sigma difusi ~3 px dan komponen ekor sampai ~90 px
// (`test/parity/regime.test.ts`). Berkas ini tinggal menghitung koreksi dan
// me-resolve-nya.
//
// PENGIKATAN BUFFER: SAMA seperti draf lama berkas ini (lih. `dir.ts`) --
// `pairASrc`/`pairBSrc` (read) dan `pairADst`/`pairBDst` (read_write) di-
// rebind ke buffer host berbeda per dispatch (pola `halation.wgsl`), bukan
// empat peran tetap. `kOpResolve` mengikat `pairBDst` ke `ctx.dest`
// (invarian ping-pong yang SAMA didokumentasikan draf lama: `ctx.dest`
// tahap ini masih berisi `log_e_film`, keluaran `filmExposure`/`halation`,
// TIDAK disentuh `curveDevelop` yang hanya membacanya) -- dibaca sebagai
// `logRaw` SEBELUM ditimpa keluaran `cmy_film` akhir, dalam dispatch yang
// SAMA (baca-lalu-tulis indeks-sama, seperti sebelumnya).
//
// Enam storage buffer (0-5) -- di bawah batas 8 (lih. catatan
// `halation.wgsl`).

@group(0) @binding(0) var<storage, read> pairASrc: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> pairADst: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> pairBSrc: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> pairBDst: array<vec4<f32>>;
@group(0) @binding(4) var<uniform> params: CoreParams;
@group(0) @binding(5) var<storage, read> stockArena: array<f32>;
// Fase 2D: matriks DIR (9 float, baris donor) lalu kurva sebelum DIR
// (`exposureCount * 3`), dihitung host per render (`src/host/dirCouplers.ts`)
// karena `amount`/`inhibition_*` kini parameter pengguna.
@group(0) @binding(6) var<storage, read> dirFrame: array<f32>;

const kOpComputeCorrection: u32 = 0u;
const kOpResolve: u32 = 5u;

// `_EXPONENTIAL_GAUSSIAN_FITS[3]` Python (fast_gaussian_filter.py) --
// amplitudo campuran 3-Gaussian yang mensurogasi PSF eksponensial. SAMA
// tabel yang `halation.wgsl::scatterTailWeight` sudah pakai (scatter tail
// halation memakai surogasi yang SAMA) -- diduplikasi di sini, bukan
// diimpor, karena tiap shader WGSL di repo ini berdiri sendiri (lih.
// duplikasi serupa `experimentalPushPullLogRaw` di bawah).

// `dir_couplers.diffusion_tail_weight` -- konstanta skema, lih. blok
// komentar berkas.
const kDiffusionTailWeight: f32 = 0.06;

const kKernelStride: u32 = 34u; // 1 (radius, disimpan sebagai f32) + 2*16+1 bobot



// Port literal `fast_gaussian_filter.py::_reflect` -- scipy `mode='reflect'`
// ("d c b a | a b c d | d c b a", TIDAK menduplikasi piksel tepi). Cabang
// modulo (i di luar [-n, 2n)) TIDAK PERNAH tereksekusi untuk kernel yang
// gerbang ini uji (radius maksimum terukur 2, jauh di bawah n manapun),
// tapi diport UTUH (bukan dipangkas ke tiga cabang pertama) supaya benar
// untuk radius lebih besar yang mungkin dipakai kelak.




fn curveExposureValue(i: u32) -> f32 {
  return stockArena[ARENA_CURVEEXPOSURE_OFFSET + i * 2u];
}

fn dirDensityCurveAt(i: u32, channel: u32) -> f32 {
  return dirFrame[9u + i * 3u + channel];
}

// Port `interpDensityCurve` `SpektraDir.comp:133-153` -- LINEAR SAJA, tanpa
// cabang Hermite (`SpektraCurveDevelop.comp`/`curveDevelop.wgsl` beda dari
// shader hulu ini secara struktural, lih. draf lama berkas ini).
fn interpDensityCurve(logRaw: f32, channel: u32) -> f32 {
  let count = params.exposureCount;
  if (count == 0u) {
    return 0.0;
  }

  let lookupRaw = select(logRaw * max(params.filmGamma, 1.0e-6), logRaw, params.filmGamma == 1.0);
  let firstX = curveExposureValue(0u);
  let lastX = curveExposureValue(count - 1u);
  if (lookupRaw <= firstX) {
    return dirDensityCurveAt(0u, channel);
  }
  if (lookupRaw >= lastX) {
    return dirDensityCurveAt(count - 1u, channel);
  }

  var lo: u32 = 0u;
  var hi: u32 = count - 1u;
  while (hi - lo > 1u) {
    let mid = (lo + hi) >> 1u;
    if (curveExposureValue(mid) <= lookupRaw) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  let x0 = curveExposureValue(lo);
  let x1 = curveExposureValue(hi);
  let y0 = dirDensityCurveAt(lo, channel);
  let y1 = dirDensityCurveAt(hi, channel);
  let t = clamp((lookupRaw - x0) / max(x1 - x0, 1.0e-9), 0.0, 1.0);
  return mix(y0, y1, t);
}

// Mesin push/pull eksperimental, TIDAK aktif untuk gerbang manapun di repo
// ini (`filmPushPullMode` selalu 0) -- diport untuk kelengkapan struktural,
// TIDAK diverifikasi. Lih. catatan sama di draf lama berkas ini.
fn developmentActivity(stops: f32) -> f32 {
  let clampedStops = clamp(stops, -2.0, 2.0);
  var developmentSeconds: f32 = 180.0;
  if (clampedStops < 0.0) {
    developmentSeconds = mix(180.0, 150.0, min(-clampedStops, 1.0));
  } else if (clampedStops <= 1.0) {
    developmentSeconds = mix(180.0, 220.0, clampedStops);
  } else {
    developmentSeconds = mix(220.0, 280.0, clampedStops - 1.0);
  }
  return log(developmentSeconds / 180.0);
}

fn pushPullSpeedGain(stops: f32) -> f32 {
  if (stops > 0.0) {
    let pushOne = mix(0.0, 0.33, min(stops, 1.0));
    return select(mix(0.33, 0.5, min(stops - 1.0, 1.0)), pushOne, stops <= 1.0);
  }
  if (stops < 0.0) {
    return mix(0.0, -0.2, min(-stops, 1.0));
  }
  return 0.0;
}

fn sigmoidCurve(u: f32) -> f32 {
  return 1.0 / (1.0 + exp(-u));
}

fn pushPullWarpLogRaw(logRaw: f32, channel: u32, stops: f32) -> f32 {
  let activity = developmentActivity(stops);
  let signedActivitySquared = activity * abs(activity);
  let midLinear = array<f32, 3>(0.25, 0.28, 0.31);
  let shoulderLinear = array<f32, 3>(0.32, 0.38, 0.45);
  let midQuadratic = array<f32, 3>(0.04, 0.06, 0.08);
  let shoulderQuadratic = array<f32, 3>(0.08, 0.12, 0.16);
  let toeMask = 1.0 - sigmoidCurve((logRaw + 2.0) / 0.5);
  let shoulderMask = sigmoidCurve(logRaw / 0.5);
  let midMask = max(1.0 - toeMask - shoulderMask, 0.0);
  let midShift = midLinear[channel] * activity + midQuadratic[channel] * signedActivitySquared;
  let shoulderShift = shoulderLinear[channel] * activity + shoulderQuadratic[channel] * signedActivitySquared;
  return logRaw + midShift * midMask + shoulderShift * shoulderMask;
}

fn experimentalPushPullLogRaw(logRaw: vec3<f32>, stops: f32) -> vec3<f32> {
  let shifted0 = logRaw - vec3<f32>((stops - pushPullSpeedGain(stops)) * 0.3010299956639812);
  let activity = developmentActivity(stops);
  let meanLogRaw = (shifted0.r + shifted0.g + shifted0.b) / 3.0;
  let coupling = mat3x3<f32>(
    vec3<f32>(0.0, -0.015, 0.015),
    vec3<f32>(0.015, 0.0, -0.015),
    vec3<f32>(-0.015, 0.015, 0.0),
  );
  let shifted = shifted0 + activity * (coupling * (shifted0 - vec3<f32>(meanLogRaw)));
  return vec3<f32>(
    pushPullWarpLogRaw(shifted.r, 0u, stops),
    pushPullWarpLogRaw(shifted.g, 1u, stops),
    pushPullWarpLogRaw(shifted.b, 2u, stops),
  );
}

fn experimentalPushPullDensityGain(logRaw: f32, channel: u32, stops: f32) -> f32 {
  let activity = developmentActivity(stops);
  let signedActivitySquared = activity * abs(activity);
  let buildLinear = array<f32, 3>(1.05, 0.95, 1.00);
  let buildQuadratic = array<f32, 3>(-0.90, -0.82, -0.86);
  let toeMask = 1.0 - sigmoidCurve((logRaw + 2.0) / 0.5);
  let shoulderMask = sigmoidCurve(logRaw / 0.5);
  let midMask = max(1.0 - toeMask - shoulderMask, 0.0);
  let regionWeight = 0.12 * toeMask + midMask + shoulderMask;
  let build = buildLinear[channel] * activity + buildQuadratic[channel] * signedActivitySquared;
  return clamp(1.0 + build * regionWeight, 0.35, 2.0);
}

fn developFilmDensity(logRaw: vec3<f32>) -> vec3<f32> {
  if (params.filmPushPullMode == 1) {
    let lookupRaw = experimentalPushPullLogRaw(logRaw, params.filmPushPullStops);
    let density = vec3<f32>(
      interpDensityCurve(lookupRaw.r, 0u),
      interpDensityCurve(lookupRaw.g, 1u),
      interpDensityCurve(lookupRaw.b, 2u),
    );
    return density * vec3<f32>(
      experimentalPushPullDensityGain(lookupRaw.r, 0u, params.filmPushPullStops),
      experimentalPushPullDensityGain(lookupRaw.g, 1u, params.filmPushPullStops),
      experimentalPushPullDensityGain(lookupRaw.b, 2u, params.filmPushPullStops),
    );
  }
  return vec3<f32>(
    interpDensityCurve(logRaw.r, 0u),
    interpDensityCurve(logRaw.g, 1u),
    interpDensityCurve(logRaw.b, 2u),
  );
}

// Port `silverDensity` `SpektraDir.comp:236-244` -- lih. draf lama berkas
// ini untuk kenapa TANPA klem tambahan yang OFX pakai (spec §6.3.1, Python
// menang).
fn silverDensity(densityCmy: vec3<f32>) -> vec3<f32> {
  if (stockArena[ARENA_DIRISPOSITIVE_OFFSET] > 0.5) {
    let densityMax = vec3<f32>(
      stockArena[ARENA_DIRDENSITYMAX_OFFSET],
      stockArena[ARENA_DIRDENSITYMAX_OFFSET + 1u],
      stockArena[ARENA_DIRDENSITYMAX_OFFSET + 2u],
    );
    return densityMax - densityCmy;
  }
  return densityCmy;
}

fn dirMatrixAt(donor: u32, receiver: u32) -> f32 {
  return dirFrame[donor * 3u + receiver];
}

// Port `correctionFromDensity` `SpektraDir.comp:246-253` --
// `output[m] = sum_k silver[k] * M[k,m]` (baris donor, kolom penerima).
// Ini SATU-SATUNYA suku yang draf lama sudah benar -- Task 18c hanya
// menambahkan difusi spasial ATAS medan `correction` mentah ini, bukan
// mengubah rumusnya.
fn correctionFromDensity(densityCmy: vec3<f32>) -> vec3<f32> {
  let silver = silverDensity(densityCmy);
  return vec3<f32>(
    silver.r * dirMatrixAt(0u, 0u) + silver.g * dirMatrixAt(1u, 0u) + silver.b * dirMatrixAt(2u, 0u),
    silver.r * dirMatrixAt(0u, 1u) + silver.g * dirMatrixAt(1u, 1u) + silver.b * dirMatrixAt(2u, 1u),
    silver.r * dirMatrixAt(0u, 2u) + silver.g * dirMatrixAt(1u, 2u) + silver.b * dirMatrixAt(2u, 2u),
  );
}

@compute @workgroup_size(32, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
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
  let x = i32(absoluteGid.x);
  let y = i32(absoluteGid.y);

  if (params.slot0 == kOpComputeCorrection) {
    // `pairASrc` diikat ke `cmyIn` (density `cmy_film` SEBELUM koreksi DIR)
    // untuk dispatch ini -- lih. `dir.ts`.
    let densityCmy = pairASrc[index].rgb;
    pairADst[index] = vec4<f32>(correctionFromDensity(densityCmy), 1.0);
    return;
  }
  if (params.slot0 == kOpResolve) {
    // `pairASrc` = medan koreksi Gaussian-dasar terblur penuh (corrBase);
    // `pairBSrc` = medan koreksi campuran-eksponensial terblur (corrTail,
    // SUDAH dijumlah-bobot amplitudo, BELUM dikali `kDiffusionTailWeight`
    // luar); `pairBDst` diikat ke `ctx.dest`, yang MASIH berisi `log_e_film`
    // pada titik ini -- lih. blok komentar berkas untuk invarian ping-pong.
    let corrBase = pairASrc[index].rgb;
    // `params.slot1` (`DirStageOptions.spatialDiffusionActive`, `dir.ts`):
    // TIDAK cukup menolkan sigma keempat kernel (radius-0 -> identitas)
    // untuk mereproduksi `diffusion_size_pixel<=0` Python BIT-EXACT --
    // `TAIL_MIXTURE`'s amplitudo (`0.1633+0.6496+0.1870=0.9999`, BUKAN
    // 1.0 persis, `_EXPONENTIAL_GAUSSIAN_FITS` Python adalah surogasi
    // fit, bukan partisi-kesatuan eksak) membuat `corrTail` sedikit BEDA
    // dari `corrRaw` bahkan pada sigma=0, jadi `(1-w)*corrBase+w*corrTail`
    // TIDAK PERSIS `corrBase` -- residual ~1e-5 ditemukan LANGSUNG lewat
    // regresi Gate A/`curveDevelop.test.ts`/`printScan.test.ts` (yang
    // semula ~1e-7) setelah Task 18c pertama kali menambahkan istilah
    // spasial. Saat `spatialDiffusionActive=false`, `corrBase` SENDIRI
    // BIT-EXACT `corrRaw` (kernel radius-0 tunggal, kali bobot 1.0,
    // TIDAK bersinggungan dengan masalah normalisasi tail) -- jadi cabang
    // ini melewati blend TAIL sepenuhnya, bukan mengandalkan sigma=0 saja.
    let spatialActive = params.slot1 != 0u;
    let corrTail = pairBSrc[index].rgb;
    let correction = select(
      corrBase,
      (1.0 - kDiffusionTailWeight) * corrBase + kDiffusionTailWeight * corrTail,
      spatialActive,
    );

    let logRawPixel = pairBDst[index];
    let correctedLogRaw = logRawPixel.rgb - correction;
    let density = developFilmDensity(correctedLogRaw);
    pairBDst[index] = vec4<f32>(max(density, vec3<f32>(0.0)), logRawPixel.a);
    return;
  }
}
