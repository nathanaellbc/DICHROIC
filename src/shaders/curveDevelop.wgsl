// Transliterasi $SPEKTRAFILM_OFX/shaders/vulkan/SpektraCurveDevelop.comp
// (246 baris, binding 0,1,2,3) ke WGSL. Tahap ini menulis tap `cmy_film`
// (Task 12) -- TAPI lih. PERINGATAN STRUKTURAL di curveDevelop.test.ts:
// `cmy_film` Python juga mencakup koreksi coupler DIR (Task 13), yang TIDAK
// diimplementasikan di sini (persis seperti hulu sendiri memisahkannya ke
// `SpektraDir.comp`). Berkas ini adalah transliterasi LENGKAP dan BENAR dari
// `SpektraCurveDevelop.comp` sendirian -- mencocokkan `develop_simple` Python
// (`model/density_curves.py::interpolate_exposure_to_density`), bukan
// `develop()` penuh.
//
// Konstanta arena (ARENA_<NAMA>_OFFSET) disambung DI DEPAN berkas ini oleh
// curveDevelop.ts, lewat `arena.wgslConstants()` -- pola yang sama dipakai
// materializeActiveRegion.ts (Task 9) dan filmExposure.ts (Task 11).
// CORE_PARAMS_WGSL disambung sebelum itu. Tahap ini HANYA mengonsumsi arena
// `stock` (Task 8) -- `curveExposure` (pasangan [nilai, 1/deltaKeTitikBerikutnya],
// port `makePackedCurveExposure` `SpektraVulkanRenderer.cpp:576-584`) dan
// `densityCurves` (kurva densitas TERNORMALISASI -- `bake_web_assets.py`
// Task 4 sudah menyimpan `_normalized_density_curves` untuk stock film,
// meniru `develop()` Python: `density_curves - np.nanmin(density_curves,
// axis=0)` -- TIDAK perlu dinormalisasi ulang di sini atau di host precompute).

@group(0) @binding(0) var<storage, read> filmRaw: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: CoreParams;
@group(0) @binding(3) var<storage, read> stockArena: array<f32>;

// Bit 1 dari slot1 -- `kColorAdaptationCurveSmoothing` hulu. TIDAK ADA
// padanan di Python (`fast_interp` Python murni linear, lih.
// `spektrafilm/utils/fast_interp.py` -- tidak ada mode Hermite/spline sama
// sekali). `defaultCoreParams` karena itu HARUS membiarkan bit ini nol untuk
// gerbang parity -- didokumentasikan di sini agar tidak ada yang menyalakannya
// dengan asumsi "lebih halus = lebih benar" (aturan kualitas proyek ini
// eksplisit: setia pada referensi, bukan lebih mulus secara teori).
const kColorAdaptationCurveSmoothing: u32 = 1u << 1u;

fn colorAdaptationEnabled(flag: u32) -> bool {
  return (params.slot1 & flag) != 0u;
}

// `curveExposure` disimpan sebagai pasangan f32 berselang-seling
// [nilai, inverseDeltaKeTitikBerikutnya] -- baca sebagai vec2 manual karena
// arena adalah `array<f32>` datar (bukan `array<vec2<f32>>`), tidak seperti
// GLSL hulu yang membuat buffer bertipe vec2 secara terpisah (binding 2).
fn curveExposureValue(i: u32) -> f32 {
  return stockArena[ARENA_CURVEEXPOSURE_OFFSET + i * 2u];
}

fn curveExposureInverseDx(i: u32) -> f32 {
  return stockArena[ARENA_CURVEEXPOSURE_OFFSET + i * 2u + 1u];
}

fn densityCurveAt(i: u32, channel: u32) -> f32 {
  return stockArena[ARENA_DENSITYCURVES_OFFSET + i * 3u + channel];
}

// Pencarian biner pada `curveExposure` lalu interpolasi linear (atau, bila
// `kColorAdaptationCurveSmoothing` menyala, Hermite kubik) pada
// `densityCurves`. Penanganan batas disalin PERSIS: `lookupRaw <= firstX`
// mengembalikan `densityCurves[channel]` (baris PERTAMA, bukan
// diekstrapolasi), `>= lastX` mengembalikan baris TERAKHIR. JANGAN ganti
// pencarian biner ini dengan sampling tekstur -- itu akan mempercepat tahap
// ini dan mengubah hasilnya; aturan kualitas proyek ini melarangnya.
fn interpDensityCurve(logRaw: f32, channel: u32) -> f32 {
  let count = params.exposureCount;
  if (count == 0u) {
    return 0.0;
  }

  let lookupRaw = select(logRaw * max(params.filmGamma, 1.0e-6), logRaw, params.filmGamma == 1.0);
  let firstX = curveExposureValue(0u);
  let lastX = curveExposureValue(count - 1u);
  if (lookupRaw <= firstX) {
    return densityCurveAt(0u, channel);
  }
  if (lookupRaw >= lastX) {
    return densityCurveAt(count - 1u, channel);
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
  let inverseDx0 = curveExposureInverseDx(lo);
  let y0 = densityCurveAt(lo, channel);
  let y1 = densityCurveAt(hi, channel);
  let t = clamp((lookupRaw - x0) * inverseDx0, 0.0, 1.0);

  if (colorAdaptationEnabled(kColorAdaptationCurveSmoothing) && count > 2u) {
    let dx0 = max(x1 - x0, 1.0e-9);
    let d0 = (y1 - y0) * inverseDx0;
    var m0 = d0;
    var m1 = d0;
    if (lo > 0u) {
      let yPrev = densityCurveAt(lo - 1u, channel);
      let dPrev = (y0 - yPrev) * curveExposureInverseDx(lo - 1u);
      m0 = select(0.0, 0.5 * (dPrev + d0), dPrev * d0 > 0.0);
    }
    if (hi + 1u < count) {
      let yNext = densityCurveAt(hi + 1u, channel);
      let dNext = (yNext - y1) * curveExposureInverseDx(hi);
      m1 = select(0.0, 0.5 * (dNext + d0), dNext * d0 > 0.0);
    }
    if (abs(d0) <= 1.0e-9) {
      m0 = 0.0;
      m1 = 0.0;
    } else {
      let limit = 3.0 * abs(d0);
      m0 = select(0.0, clamp(m0, -limit, limit), d0 * m0 > 0.0);
      m1 = select(0.0, clamp(m1, -limit, limit), d0 * m1 > 0.0);
    }
    let t2 = t * t;
    let t3 = t2 * t;
    return (2.0 * t3 - 3.0 * t2 + 1.0) * y0 +
      (t3 - 2.0 * t2 + t) * dx0 * m0 +
      (-2.0 * t3 + 3.0 * t2) * y1 +
      (t3 - t2) * dx0 * m1;
  }
  return mix(y0, y1, t);
}

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
  let toeLinear = array<f32, 3>(0.0, 0.0, 0.0);
  let midLinear = array<f32, 3>(0.25, 0.28, 0.31);
  let shoulderLinear = array<f32, 3>(0.32, 0.38, 0.45);
  let toeQuadratic = array<f32, 3>(0.0, 0.0, 0.0);
  let midQuadratic = array<f32, 3>(0.04, 0.06, 0.08);
  let shoulderQuadratic = array<f32, 3>(0.08, 0.12, 0.16);
  let toeMask = 1.0 - sigmoidCurve((logRaw + 2.0) / 0.5);
  let shoulderMask = sigmoidCurve(logRaw / 0.5);
  let midMask = max(1.0 - toeMask - shoulderMask, 0.0);
  let toeShift = toeLinear[channel] * activity + toeQuadratic[channel] * signedActivitySquared;
  let midShift = midLinear[channel] * activity + midQuadratic[channel] * signedActivitySquared;
  let shoulderShift = shoulderLinear[channel] * activity + shoulderQuadratic[channel] * signedActivitySquared;
  return logRaw + toeShift * toeMask + midShift * midMask + shoulderShift * shoulderMask;
}

fn experimentalPushPullLogRaw(logRaw: vec3<f32>, stops: f32) -> vec3<f32> {
  let shifted0 = logRaw - vec3<f32>((stops - pushPullSpeedGain(stops)) * 0.3010299956639812);
  let activity = developmentActivity(stops);
  let meanLogRaw = (shifted0.r + shifted0.g + shifted0.b) / 3.0;
  // Baris donor, kolom penerima -- SAMA dengan urutan konstruksi `mat3`
  // GLSL hulu, yang membangun matriks kolom-demi-kolom dari tiga vec3 baris.
  let coupling = mat3x3<f32>(
    0.0, 0.015, -0.015,
    -0.015, 0.0, 0.015,
    0.015, -0.015, 0.0,
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
  let rawPixel = filmRaw[index];
  let logRaw = rawPixel.rgb;
  let density = developFilmDensity(logRaw);
  dst[index] = vec4<f32>(max(density, vec3<f32>(0.0)), rawPixel.a);
}
