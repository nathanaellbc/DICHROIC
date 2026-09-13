// Transliterasi $SPEKTRAFILM_OFX/shaders/vulkan/SpektraHalation.comp
// (322 baris) ke WGSL, minus operasi boost-highlight (kOpBoostMax/
// kOpBoostReduceMax/kOpBoostApply) -- lih. `halation.ts` untuk alasan
// deferral itu. Menutup gerbang `log_e_film` pada keluarga fixture
// `measured` (Task 14), setelah `filmExposure.wgsl` (Task 11) dijalankan
// dengan `slot0=1` (raw LINEAR, bukan log).
//
// Sumber Python: `$SPEKTRAFILM_PY/src/spektrafilm/model/diffusion.py::
// apply_halation_um`, plus `fast_exponential_filter`/`fast_gaussian_filter`
// (`utils/fast_gaussian_filter.py`). Dua bagian genuinely terpisah:
//   1. Scatter dalam-emulsi -- campuran hemat-energi Gaussian core
//      (`scatter_core_um`) + ekor eksponensial (`scatter_tail_um`,
//      di-dispatch ke campuran 3-Gaussian oleh `fast_exponential_filter`,
//      TIRU PERSIS tabel amplitudo/rasio-nya -- itu APROKSIMASI hulu,
//      bukan sesuatu untuk "diperbaiki").
//   2. Halation refleksi-balik -- jumlah aditif N=3 Gaussian dengan lebar
//      `sqrt(k)` (`halation_strength`, `halation_first_sigma_um`).
//
// KONSTANTA HARDCODE, DIBUKTIKAN BUKAN DITEBAK (lih. task-14-report.md):
// `scatter_core_um`, `scatter_tail_um`, `scatter_tail_weight`, keempat
// knob "amount/scale" (semuanya 1.0), `halation_n_bounces` (3),
// `halation_bounce_decay` (0.5), dan `halation_renormalize` (True) adalah
// SATU-SATUNYA nilai yang `_apply_halation_preset`
// (params_builder.py:243-252) TIDAK PERNAH sentuh untuk stock APA PUN --
// hanya `halation_strength`/`halation_first_sigma_um` berubah per stock
// (dari tabel preset (use, antihalation), dibaca dari arena `stock` di
// bawah). `SpektraHalation.comp` hulu sendiri menghardcode angka yang
// SAMA (`sigmaForMode`, `scatterTailWeight`) -- port ini meniru itu, bukan
// menciptakan jalan pintas baru.
//
// BINDING (dirombak dari binding hulu 0/1/2/3/27 ke tata letak lokal
// berkelanjutan 0-6, sama seperti Task 11-13 -- lih. filmExposure.wgsl):
//   0: pairA_src   (read)       -- "Input0"/"in0" GLSL
//   1: pairA_dst   (read_write) -- "Buffer1"/"buf1" GLSL
//   2: pairB_src   (read)       -- "Input2"/"in2" GLSL
//   3: pairB_dst   (read_write) -- "Buffer3"/"buf3" GLSL
//   4: params      (uniform CoreParams) -- slot0=operation, slot1=sigmaMode,
//      slot2=component, PERSIS peta slot Halation yang dicatat params.ts.
//   5: stockArena   (read) -- ARENA_HALATIONSTRENGTH_OFFSET/
//      ARENA_HALATIONFIRSTSIGMAUM_OFFSET (Task 14, ditambahkan ke arena
//      `stock` yang sudah ada, lih. host/spectral.ts).
//   6: frameFloats (read) -- SATU float: `pixel_size_um`, dihitung per-run
//      oleh `halation.ts` dari `params.fullWidth`/`fullHeight` (bukan
//      per-stock, jadi TIDAK bisa hidup di arena `stock`/`dynamic` yang
//      di-cache lintas kasus uji berbeda ukuran -- lih. `halation.ts`).
//
// Empat storage buffer pixel (0,1,2,3) + stockArena (5) + frameFloats (6)
// = 6 storage buffer, di bawah batas 8.

@group(0) @binding(0) var<storage, read> pairASrc: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> pairADst: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> pairBSrc: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> pairBDst: array<vec4<f32>>;
@group(0) @binding(4) var<uniform> params: CoreParams;
@group(0) @binding(5) var<storage, read> stockArena: array<f32>;
@group(0) @binding(6) var<storage, read> frameFloats: array<f32>;

const kLog10E: f32 = 0.4342944819032518;

const kOpClear: u32 = 0u;
const kOpBlurX: u32 = 1u;
const kOpBlurYStore: u32 = 2u;
const kOpBlurYAccumulate: u32 = 3u;
const kOpScatterResolve: u32 = 4u;
const kOpBounceResolveLog: u32 = 5u;
const kOpRawToLog: u32 = 6u;

const kSigmaScatterCore: u32 = 0u;
const kSigmaScatterTail: u32 = 1u;
const kSigmaBounce: u32 = 2u;

// `frameFloats[kFrameFilmPixelSizeUm]` -- seluruh larik hanya berisi satu
// elemen di port ini (lih. dokumentasi binding di atas), beda dari GLSL
// hulu yang berbagi satu larik besar lintas banyak shader.
const kFrameFilmPixelSizeUm: u32 = 0u;

// Knob "amount/scale" HalationParams -- SEMUANYA 1.0 default, tidak pernah
// disentuh `_apply_halation_preset` maupun `gen_reference.py`. Lih. blok
// komentar modul di atas.
const kScatterAmount: f32 = 1.0;
const kScatterSpatialScale: f32 = 1.0;
const kHalationAmount: f32 = 1.0;
const kHalationSpatialScale: f32 = 1.0;

fn pixelSizeUm() -> f32 {
  return max(frameFloats[kFrameFilmPixelSizeUm], 1.0e-6);
}

fn safeIndex(index: i32, size: u32) -> u32 {
  if (size <= 1u) {
    return 0u;
  }
  return u32(clamp(index, 0, i32(size) - 1));
}

fn sampleRaw(x: i32, y: i32) -> vec4<f32> {
  let sx = safeIndex(x, params.width);
  let sy = safeIndex(y, params.height);
  return pairASrc[sy * params.width + sx];
}

fn max3(v: vec3<f32>) -> f32 {
  return max(max(v.r, v.g), v.b);
}

// Amplitudo `_EXPONENTIAL_GAUSSIAN_FITS[3]` Python (fast_gaussian_filter.py)
// -- juga dipakai sebagai bobot bounce (lih. cabang sigmaMode di bawah).
fn scatterTailWeight(component: u32) -> f32 {
  if (component == 0u) { return 0.1633; }
  if (component == 1u) { return 0.6496; }
  return 0.1870;
}

fn sigmaForMode() -> vec3<f32> {
  let pxUm = pixelSizeUm();
  if (params.slot1 == kSigmaScatterCore) {
    return vec3<f32>(2.2, 2.0, 1.6) * kScatterSpatialScale / pxUm;
  }
  if (params.slot1 == kSigmaScatterTail) {
    var ratio: f32 = 2.7684;
    if (params.slot2 == 0u) { ratio = 0.5360; }
    else if (params.slot2 == 1u) { ratio = 1.5236; }
    return vec3<f32>(9.3, 9.7, 9.1) * ratio * kScatterSpatialScale / pxUm;
  }
  let o = ARENA_HALATIONFIRSTSIGMAUM_OFFSET;
  let firstSigma = max(
    vec3<f32>(stockArena[o], stockArena[o + 1u], stockArena[o + 2u]),
    vec3<f32>(1.0e-6),
  );
  return firstSigma * kHalationSpatialScale * sqrt(f32(params.slot2 + 1u)) / pxUm;
}

// Gaussian FIR terpotong, sama persis dengan `gaussianSampleX`/Y GLSL:
// radius = min(ceil(3*maxSigma), 256), bobot lewat rekursi
// exp(-0.5/sigma^2) * exp(-1/sigma^2)^n alih-alih memanggil exp() per
// offset. Untuk sigma sekecil test fixture Task 14 (pixel_size_um besar,
// sigma mikron << 1 piksel), `weight` untuk offset != 0 underflow ke 0.0
// f32 -- itu SAMA dengan kernel radius-0 (identitas) Python
// (`_gaussian_kernel_1d`, radius = int(3*sigma+0.5) = 0 untuk sigma
// sekecil ini), dibuktikan numerik di task-14-report.md.
fn gaussianSampleX(gid: vec2<u32>, sigma: vec3<f32>) -> vec4<f32> {
  let maxSigma = max3(sigma);
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (maxSigma <= 1.0e-4) {
    return sampleRaw(x, y);
  }
  let radius = min(i32(ceil(3.0 * maxSigma)), 256);
  let safeSigma = max(sigma, vec3<f32>(1.0e-6));
  let invSigma2 = 1.0 / max(safeSigma * safeSigma, vec3<f32>(1.0e-8));
  var weight = exp(-0.5 * invSigma2);
  var ratio = exp(-1.5 * invSigma2);
  let ratioStep = exp(-invSigma2);
  var value = sampleRaw(x, y);
  var weightSum = vec3<f32>(1.0);
  for (var offset: i32 = 1; offset <= radius; offset = offset + 1) {
    let samplePair = sampleRaw(x - offset, y) + sampleRaw(x + offset, y);
    value = vec4<f32>(value.rgb + samplePair.rgb * weight, value.a + samplePair.a);
    weightSum += 2.0 * weight;
    weight *= ratio;
    ratio *= ratioStep;
  }
  value = vec4<f32>(value.rgb / max(weightSum, vec3<f32>(1.0e-8)), value.a / f32(radius * 2 + 1));
  return value;
}

fn gaussianSampleY(gid: vec2<u32>, sigma: vec3<f32>) -> vec4<f32> {
  let maxSigma = max3(sigma);
  let x = i32(gid.x);
  let y = i32(gid.y);
  if (maxSigma <= 1.0e-4) {
    return sampleRaw(x, y);
  }
  let radius = min(i32(ceil(3.0 * maxSigma)), 256);
  let safeSigma = max(sigma, vec3<f32>(1.0e-6));
  let invSigma2 = 1.0 / max(safeSigma * safeSigma, vec3<f32>(1.0e-8));
  var weight = exp(-0.5 * invSigma2);
  var ratio = exp(-1.5 * invSigma2);
  let ratioStep = exp(-invSigma2);
  var value = sampleRaw(x, y);
  var weightSum = vec3<f32>(1.0);
  for (var offset: i32 = 1; offset <= radius; offset = offset + 1) {
    let samplePair = sampleRaw(x, y - offset) + sampleRaw(x, y + offset);
    value = vec4<f32>(value.rgb + samplePair.rgb * weight, value.a + samplePair.a);
    weightSum += 2.0 * weight;
    weight *= ratio;
    ratio *= ratioStep;
  }
  value = vec4<f32>(value.rgb / max(weightSum, vec3<f32>(1.0e-8)), value.a / f32(radius * 2 + 1));
  return value;
}

@compute @workgroup_size(32, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let activeWidth = select(params.activeWidth, params.width, params.activeWidth == 0u);
  let activeHeight = select(params.activeHeight, params.height, params.activeHeight == 0u);
  if (gid.x >= activeWidth || gid.y >= activeHeight) {
    return;
  }
  let localGid = gid.xy + vec2<u32>(params.activeOriginX, params.activeOriginY);
  if (localGid.x >= params.width || localGid.y >= params.height) {
    return;
  }
  let index = localGid.y * params.width + localGid.x;

  if (params.slot0 == kOpClear) {
    pairADst[index] = vec4<f32>(0.0, 0.0, 0.0, pairASrc[index].a);
    return;
  }
  if (params.slot0 == kOpBlurX) {
    pairADst[index] = gaussianSampleX(localGid, sigmaForMode());
    return;
  }
  if (params.slot0 == kOpBlurYStore) {
    pairADst[index] = gaussianSampleY(localGid, sigmaForMode());
    return;
  }
  if (params.slot0 == kOpBlurYAccumulate) {
    let blurred = gaussianSampleY(localGid, sigmaForMode());
    var weight: f32;
    if (params.slot1 == kSigmaBounce) {
      weight = pow(0.5, f32(params.slot2)) / 1.75;
    } else {
      weight = scatterTailWeight(params.slot2);
    }
    pairADst[index] = vec4<f32>(pairADst[index].rgb + weight * blurred.rgb, blurred.a);
    return;
  }
  if (params.slot0 == kOpScatterResolve) {
    let raw = pairASrc[index];
    let tailMix = vec3<f32>(0.78, 0.65, 0.67); // scatter_tail_weight (w_s)
    let scattered = (vec3<f32>(1.0) - tailMix) * pairADst[index].rgb + tailMix * pairBSrc[index].rgb;
    let amount = clamp(kScatterAmount, 0.0, 1.0);
    pairBDst[index] = vec4<f32>(mix(raw.rgb, scattered, amount), raw.a);
    return;
  }
  if (params.slot0 == kOpBounceResolveLog) {
    let raw = pairASrc[index];
    let o = ARENA_HALATIONSTRENGTH_OFFSET;
    let amount = max(vec3<f32>(stockArena[o], stockArena[o + 1u], stockArena[o + 2u]), vec3<f32>(0.0))
      * max(kHalationAmount, 0.0);
    let resolved = (raw.rgb + amount * pairADst[index].rgb) / (vec3<f32>(1.0) + amount);
    pairBDst[index] = vec4<f32>(log(max(resolved, vec3<f32>(0.0)) + vec3<f32>(1.0e-10)) * kLog10E, raw.a);
    return;
  }
  if (params.slot0 == kOpRawToLog) {
    let raw = pairASrc[index];
    pairBDst[index] = vec4<f32>(log(max(raw.rgb, vec3<f32>(0.0)) + vec3<f32>(1.0e-10)) * kLog10E, raw.a);
    return;
  }
}
