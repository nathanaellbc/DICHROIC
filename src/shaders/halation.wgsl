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

// FASE 2A.5: semua blur (scatter core, ekor eksponensial, tiga bounce) kini
// dijalankan primitif bersama `GaussianBlur` (`src/engine/gaussian.ts`,
// `gaussian.wgsl`) -- port `fast_gaussian_filter` hulu termasuk jalur IIR
// Young-van Vliet untuk sigma >= 3 px. FIR sendiri yang dulu ada di sini
// (radius ceil(3*sigma), batas clamp, gaya OFX) cocok dengan Python HANYA di
// ukuran piksel fixture Fase 1 (~550 um, sigma << 1 px); di 6 um/px ia
// meleset sampai 3e-2 pada log_e_film (`test/parity/regime.test.ts`).
// Berkas ini tinggal operasi kombinasi per piksel.

@group(0) @binding(0) var<storage, read> pairASrc: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> pairADst: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> pairBSrc: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> pairBDst: array<vec4<f32>>;
@group(0) @binding(4) var<uniform> params: CoreParams;
@group(0) @binding(5) var<storage, read> stockArena: array<f32>;

const kLog10E: f32 = 0.4342944819032518;

const kOpScatterResolve: u32 = 4u;
const kOpBounceResolveLog: u32 = 5u;

const kScatterAmount: f32 = 1.0;
const kHalationAmount: f32 = 1.0;

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

  if (params.slot0 == kOpScatterResolve) {
    // `apply_halation_um` langkah 1: scattered = (1-w_s)*core + w_s*tail;
    // raw = (1-s)*raw + s*scattered. pairADst = core, pairBSrc = tail.
    let raw = pairASrc[index];
    let tailMix = vec3<f32>(0.78, 0.65, 0.67); // scatter_tail_weight (w_s)
    let scattered = (vec3<f32>(1.0) - tailMix) * pairADst[index].rgb + tailMix * pairBSrc[index].rgb;
    let amount = clamp(kScatterAmount, 0.0, 1.0);
    pairBDst[index] = vec4<f32>(mix(raw.rgb, scattered, amount), raw.a);
    return;
  }
  if (params.slot0 == kOpBounceResolveLog) {
    // Langkah 2 + renormalisasi + log10 (halation menutup log_e_film untuk
    // keluarga measured). pairASrc = raw setelah scatter, pairADst = jumlah
    // bounce berbobot.
    let raw = pairASrc[index];
    let o = ARENA_HALATIONSTRENGTH_OFFSET;
    let amount = max(vec3<f32>(stockArena[o], stockArena[o + 1u], stockArena[o + 2u]), vec3<f32>(0.0))
      * max(kHalationAmount, 0.0);
    let resolved = (raw.rgb + amount * pairADst[index].rgb) / (vec3<f32>(1.0) + amount);
    pairBDst[index] = vec4<f32>(log(max(resolved, vec3<f32>(0.0)) + vec3<f32>(1.0e-10)) * kLog10E, raw.a);
    return;
  }
}
