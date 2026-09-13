// Transliterasi PARSIAL $SPEKTRAFILM_OFX/shaders/vulkan/SpektraDir.comp
// (329 baris, 7 operasi lewat `params.slot0`/`kOp*`) ke WGSL, menutup
// gerbang `cmy_film` (Task 13) yang Task 12 sengaja tinggalkan gagal.
//
// CAKUPAN, DIBUKTIKAN BUKAN DITEBAK (lih. task-13-report.md untuk skrip
// host-math f64 yang membuktikan pilihan di bawah cocok dengan fixture
// Python sampai ~1e-7 SEBELUM baris WGSL manapun ditulis):
//
//   Diimplementasikan (kOpCorrectionFromDensity + kOpRedevelop, digabung
//   jadi SATU dispatch di sini karena keduanya per-piksel murni saat
//   difusi mati):
//     - `silverDensity`: `density_cmy` apa adanya untuk film negatif,
//       `densityMax - density_cmy` untuk film positif (dibaca dari arena,
//       BUKAN diasumsikan dari nama stock).
//     - `correctionFromDensity`: perkalian matriks 1x3 * 3x3 (matriks
//       crosstalk donor->penerima, `dirCouplersMatrix`).
//     - `developFilmDensity`/`interpDensityCurve` atas tabel
//       `dirDensityCurvesBeforeCouplers` (BUKAN `densityCurves` biasa --
//       ini tabel HASIL `compute_density_curves_before_dir_couplers`
//       Python, dihitung SEKALI per stock di host, lih.
//       `src/host/spectral.ts`), dengan grid-x `curveExposure` yang SAMA
//       dipakai `curveDevelop.wgsl`.
//
//   TIDAK diimplementasikan, SENGAJA, dan AMAN diabaikan untuk gerbang ini:
//     - `high_exposure_couplers_shift` (`density_silver +=
//       shift*density_silver^2` di `compute_exposure_correction_dir_couplers`
//       Python): `apply_density_correction_dir_couplers` memanggil fungsi
//       itu TANPA meneruskan argumen ini sama sekali, jadi ia selalu
//       memakai default `0.0` -- suku ini SELALU nol untuk seluruh
//       pipeline Python saat ini, bukan hanya untuk keluarga `_lut`. Tidak
//       ada jalur kode manapun yang bisa menyalakannya hari ini.
//     - Difusi spasial dua-skala (`kOpBlurX/Y`, `kOpTailClear`,
//       `kOpTailBlurX/YAccumulate`, param `dirBaseSigma`/`dirTailSigma`/
//       `dirTailWeight`): `diffusion_size_um` dinolkan
//       `deactivate_spatial_effects`, yang DIPROMOSIKAN `lut_mode`
//       (params_builder.py:129) -- `apply_density_correction_dir_couplers`
//       Python sendiri MENG-SHORT-CIRCUIT filter ini
//       (`if diffusion_size_pixel>0`) saat itu terjadi, jadi
//       `log_raw_correction` sama dengan sebelum difilter. TIDAK diport di
//       sini; harus diverifikasi TERPISAH kelak terhadap keluarga fixture
//       yang efeknya HIDUP (`hard_edge_dir` di rencana awal Task 13),
//       BUKAN gerbang `lut_mode` ini -- sama seperti Halation/Diffusion/
//       Grain (Task 14-16) digerbangi di tap tetangganya sendiri, bukan di
//       sini.
//
// KONVENSI MATRIKS: `dirCouplersMatrix` disimpan baris-mayor
// donor*3+penerima (SAMA dengan `contract('jk,km->jm', ...)` Python, `k`
// donor `m` penerima) -- dibuktikan cocok dengan indeks `M[0],M[3],M[6]`
// yang OFX pakai untuk kanal keluaran 0 di `correctionFromDensity`
// (`SpektraDir.comp:257-262`).
//
// `interpDensityCurve` di sini TIDAK punya cabang Hermite
// (`kColorAdaptationCurveSmoothing`) -- `SpektraDir.comp`'s
// `interpDensityCurve` (baris 133-153 hulu) murni linear, TIDAK seperti
// `SpektraCurveDevelop.comp`/`curveDevelop.wgsl`. Ini perbedaan struktural
// ANTARA KEDUA SHADER HULU, bukan penyimpangan port ini.
//
// Konstanta arena (ARENA_<NAMA>_OFFSET) disambung DI DEPAN berkas ini oleh
// dir.ts, lewat `arena.wgslConstants()` -- arena `stock` yang SAMA dipakai
// curveDevelop.ts (Task 12), diperluas Task 13 dengan `dirCouplersMatrix`,
// `dirDensityMax`, `dirIsPositive`, `dirDensityCurvesBeforeCouplers`.
//
// PENGIKATAN BUFFER, TIDAK LAZIM DAN DIDOKUMENTASIKAN DI SINI SECARA
// EKSPLISIT: tahap ini HARUS berjalan tepat setelah CurveDevelop pada
// RenderGraph yang sama (persis peta tap plan: `cmy_film` = CurveDevelop +
// Dir berurutan). `binding 0` (`cmyIn`, read) adalah `ctx.source` --
// keadaan `cmy_film` SAAT INI, keluaran CurveDevelop. `binding 1` (`dst`,
// read_write) adalah `ctx.dest` -- lewat invarian ping-pong `graph.ts`
// (`ctx.dest` tahap ke-i SELALU sama dengan `ctx.source` tahap ke-(i-1)),
// buffer ini masih berisi `log_e_film` (masukan CurveDevelop, TIDAK
// disentuh CurveDevelop yang hanya membacanya) pada saat dispatch ini
// mulai -- dibaca sebagai `logRaw` SEBELUM overwrite pertama, persis pola
// baca-lalu-tulis indeks-sama yang sudah dipakai `curveDevelop.wgsl`
// sendiri (`filmRaw: read` + `dst: read_write`, sekarang perannya ditukar).
@group(0) @binding(0) var<storage, read> cmyIn: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: CoreParams;
@group(0) @binding(3) var<storage, read> stockArena: array<f32>;

fn curveExposureValue(i: u32) -> f32 {
  return stockArena[ARENA_CURVEEXPOSURE_OFFSET + i * 2u];
}

fn dirDensityCurveAt(i: u32, channel: u32) -> f32 {
  return stockArena[ARENA_DIRDENSITYCURVESBEFORECOUPLERS_OFFSET + i * 3u + channel];
}

// Port `interpDensityCurve` `SpektraDir.comp:133-153` -- LINEAR SAJA, tanpa
// cabang Hermite (lih. catatan berkas di atas). Sama seperti
// `curveDevelop.wgsl`, penanganan batas `<= firstX`/`>= lastX` mengembalikan
// baris PERTAMA/TERAKHIR langsung, bukan ekstrapolasi.
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

// Mesin push/pull eksperimental, PERSIS `SpektraDir.comp:159-234` --
// TIDAK aktif untuk gerbang ini (`filmPushPullMode` selalu 0 di setiap
// fixture Task 13), diport untuk kelengkapan struktural sama seperti
// `curveDevelop.wgsl` (Task 12) melakukannya untuk `SpektraCurveDevelop.comp`.
// TIDAK diverifikasi gerbang manapun (lih. peringatan yang sama di
// curveDevelop.wgsl) -- transkripsi literal dari GLSL hulu, bukan dari
// salinan `curveDevelop.wgsl`, karena kedua shader hulu punya salinan
// fungsi ini masing-masing dan tidak dijamin identik bit-demi-bit.
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
  // Kolom-demi-kolom, PERSIS urutan argumen `mat3(...)` GLSL hulu
  // (`SpektraDir.comp:180-184`) -- CATATAN: tanda berlawanan dengan
  // salinan `curveDevelop.wgsl` (kedua shader hulu punya konstanta
  // berbeda di sini; lih. komentar berkas di atas).
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

// Port `silverDensity` `SpektraDir.comp:236-244` -- TANPA `max(...,0.0)`
// tambahan yang OFX pakai di cabang negatif: `compute_exposure_correction_
// dir_couplers` Python (`density_silver = np.copy(density_cmy)`) TIDAK
// mengklem, dan spec §6.3.1 memerintahkan Python menang saat kedua repo
// hulu berbeda. Tidak berdampak numerik untuk gerbang ini (density_cmy
// CurveDevelop sudah >=0 lewat klemnya sendiri), tapi diikuti dengan
// sengaja, bukan diam-diam disalin dari OFX.
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
  return stockArena[ARENA_DIRCOUPLERSMATRIX_OFFSET + donor * 3u + receiver];
}

// Port `correctionFromDensity` `SpektraDir.comp:246-253` --
// `output[m] = sum_k silver[k] * M[k,m]` (baris donor, kolom penerima).
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
  let activeGid = gid.xy;
  let activeWidth = select(params.width, params.activeWidth, params.activeWidth != 0u);
  let activeHeight = select(params.height, params.activeHeight, params.activeHeight != 0u);
  if (activeGid.x >= activeWidth || activeGid.y >= activeHeight) {
    return;
  }

  let absoluteGid = activeGid + vec2<u32>(params.activeOriginX, params.activeOriginY);
  if (absoluteGid.x >= params.width || absoluteGid.y >= params.height) {
    return;
  }
  let index = absoluteGid.y * params.width + absoluteGid.x;

  // `dst` MASIH berisi `log_e_film` pada titik ini -- lih. catatan
  // pengikatan buffer di atas berkas. Dibaca ke variabel lokal SEBELUM
  // ditulis ulang di baris terakhir fungsi ini.
  let logRawPixel = dst[index];
  let logRaw = logRawPixel.rgb;
  let densityCmy = cmyIn[index].rgb;

  // Difusi spasial dilewati (lih. catatan berkas): `log_raw_correction`
  // dipakai langsung tanpa filter Gaussian/ekor eksponensial, PERSIS
  // cabang `diffusion_size_pixel<=0` Python.
  let correction = correctionFromDensity(densityCmy);
  let correctedLogRaw = logRaw - correction;
  let density = developFilmDensity(correctedLogRaw);
  dst[index] = vec4<f32>(max(density, vec3<f32>(0.0)), logRawPixel.a);
}
