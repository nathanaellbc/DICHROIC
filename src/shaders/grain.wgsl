// Transliterasi $SPEKTRAFILM_PY/src/spektrafilm/model/grain.py (bukan
// $SPEKTRAFILM_OFX/shaders/vulkan/SpektraGrain.comp, 1.183 baris) -- lih.
// Global Constraints/koreksi Task 15: hulu punya DUA implementasi dan yang
// mengikat kita adalah Python. Grain adalah pasangan paling divergen di
// seluruh proyek (numba/scipy RNG vs 1183 baris GLSL); shader OFX hanya
// dipakai untuk mengecek konvensi buffer scratch, bukan sebagai sumber
// algoritma. Menutup gerbang STATISTIK (mean/varians/spektrum daya radial)
// pada tap `cmy_film`, dua keluarga fixture berbeda -- BUKAN gerbang
// per-piksel. Alasannya BUKAN karena Python acak (dengan `fixed_seed=None`,
// `grain.py:84-87` menyetel `seed=[0,1,2]`, jadi bagian Poisson-Binomial
// Python sendiri DETERMINISTIK antar-run), tapi karena RNG WGSL di sini
// adalah ALGORITMA BERBEDA dari numba/scipy Python: dua implementasi yang
// sama-sama benar menghasilkan realisasi butir berbeda pada piksel yang
// sama dengan statistik yang sama. JANGAN naikkan ini jadi gerbang
// per-piksel dan JANGAN longgarkan toleransi statistik tanpa mengukur ulang
// sebarannya (spec §6.5.1, "ambang terikat sebaran terukur").
//
// ============================================================================
// TASK 16b -- `blur_particle` DAN `add_micro_structure` DIPORT, TIDAK LAGI
// DITUNDA. Lih. `.superpowers/sdd/2026-09-11-dichroic-phase1-engine/
// task-16b-report.md` untuk transkrip pengukuran lengkap. Task 16 menunda
// keduanya dengan alasan JUJUR ("no-op TERBUKTI untuk fixture 64px ini")
// tapi menandai eksplisit bahwa deferral itu BERGANTUNG pixel_size_um,
// bukan struktural -- fixture baru `grain_dense_patch` (64x64,
// `camera.film_format_mm=0.024` -> `pixel_size_um=0.375`, lih. `grain.ts`)
// membuat KEDUANYA aktif secara terukur:
//   - blur_particle: sigma = blur_dye_clouds_um*sqrt(od_particle) berkisar
//     1.44..4.47 di fixture ini (radius kernel 4..13), vs ~5e-4..3e-3
//     (radius 0, no-op TERBUKTI) di fixture `_stochastic` lama.
//   - add_micro_structure: grain_micro_structure_sigma=0.08 > ambang
//     aktivasi Python `0.05` (vs ~5e-5 di fixture lama), DAN
//     grain_micro_structure_blur_pixel=0.533 > ambang blur-clumping `0.4`
//     -- kedua cabang bersarang `add_micro_structure` aktif.
//
// TEMUAN PENTING (task-16b-report.md): pada `pixel_size_um` sekecil ini,
// `n_particles_per_pixel` per (kanal,sublapisan) turun ke orde 0,03..0,35 --
// JAUH di bawah rezim "banyak partikel" (1e5..1e7) yang membuat aproksimasi
// analitik Task 16 (Poisson-thinning EKSAK + aproksimasi Normal PADA HASIL
// thinning) presisi tinggi. Identitas Poisson-thinning
// (`Binomial(Poisson(lambda),p) ~ Poisson(lambda*p)`) tetap EKSAK pada n
// berapa pun -- rumus `mu`/`variance` di bawah TIDAK berubah dan TERBUKTI
// eksak lewat Monte Carlo langsung terhadap `layer_particle_model` Python
// sungguhan (task-16b-report.md, `mc_check.py`, cocok 4-5 angka signifikan
// di seluruh rentang p). Yang TIDAK diubah dari Task 16: sampel akhir tetap
// SATU tarikan Normal(mu,variance) per (piksel,kanal,sublapisan), BUKAN
// simulasi Poisson diskret -- pada n kecil ini artinya bentuk (skewness)
// realisasi tunggal kami MENYIMPANG dari distribusi Poisson-Binomial
// sungguhan Python (yang diskret, banyak nol), tapi mean DAN variance-nya
// (dua momen yang gerbang statistik ukur) tetap TEPAT sama secara aljabar.
// Konsekuensinya BUKAN bug, melainkan sebaran sampling asli yang jauh lebih
// besar daripada di fixture lama (dikonfirmasi lewat 60 realisasi Monte
// Carlo independen atas implementasi kami sendiri, task-16b-report.md):
// std rata-rata antar-piksel ~2-4%, variance relatif ~11-19%, daya radial
// per-bin ~15-60% -- gerbang `grain.test.ts` untuk `grain_dense_patch`
// memakai ambang yang dikalibrasi terhadap sebaran TERUKUR ini (jauh lebih
// longgar dari 5e-5/2%/5% Task 16, yang dikalibrasi pada rezim partikel
// yang sama sekali berbeda), BUKAN mewarisi angka Task 16 mentah-mentah.
//
// TUJUH COMPUTE ENTRY POINT BARU (menggantikan satu `generate()` lama):
//   generateLayers() -- per (piksel,kanal,sublapisan): sampel Normal
//     analitik SAMA seperti Task 16, ditulis ke `layerRaw` (BUKAN langsung
//     dijumlah lintas sublapisan seperti dulu) -- setiap sublapisan
//     butuh sigma blur_particle SENDIRI (bergantung `od_particle`-nya
//     sendiri), jadi HARUS diblur sebelum dijumlah (blur bukan operasi yang
//     bisa dipertukarkan urutannya dengan penjumlahan lintas kernel
//     berbeda).
//   blurLayersX/Y() -- blur reflect-padded PER SUBLAPISAN PER KANAL (sigma
//     beda-beda, lih. `layerBlurSigma`), lalu MENJUMLAHKAN lintas
//     sublapisan di `blurLayersY` (persis `density_cmy_out[:,:,ch] +=
//     layer_particle_model(...)` Python) -> `layerSummed`.
//   microGenerate/microBlurX/Y() -- `add_micro_structure`: field lognormal
//     IID per (piksel,kanal) dengan mean=1 (SAMA UNTUK SEMUA piksel/kanal
//     kalau `grain_micro_structure_sigma<=0.05`, cabang Python eksplisit
//     TIDAK menerapkan clumping sama sekali -- diport sebagai CABANG
//     BENAR, bukan mengandalkan sigma->0 self-regulating seperti
//     blur_particle, karena ambang aktivasi micro-structure ITU SENDIRI
//     ada di kode Python, bukan cuma properti numerik kernel Gaussian).
//     Blur bersarangnya (`grain_micro_structure_blur_pixel>0.4`) JUGA
//     cabang eksplisit Python -- diport sebagai `select(radius,0,...)`,
//     BUKAN dibiarkan self-regulating, karena ambang 0.4 itu LEBIH TINGGI
//     dari titik sigma mana pun sudah membuat kernel Gaussian ber-radius 0
//     (~0.1667) -- rentang [0.1667,0.4) Python SENGAJA TIDAK MEMBLUR sama
//     sekali, sedangkan formula kernel yang self-regulating akan MEMBLUR di
//     rentang itu (radius>=1). Membiarkannya self-regulating akan
//     memperkenalkan blur yang Python sendiri TIDAK lakukan -- persis
//     pelanggaran "jangan perkenalkan aproksimasi sendiri" yang Global
//     Constraints larang.
//   combine() -- `layerSummed * microBlurred - density_min` -> `preBlur`,
//     titik masuk yang SAMA persis dengan keluaran lama `generate()`
//     sebelum `blurX`/`blurY` (grain_blur=0.65) akhir yang TIDAK berubah.
//
// Pada fixture `_stochastic` LAMA (blur_particle & micro-structure TERBUKTI
// no-op di sana, lih. task-16-report.md), pipeline tujuh-tahap ini
// SECARA MATEMATIS runtuh jadi identik dengan `generate()` lama: sigma
// blur_particle tiap (kanal,sublapisan) < 1/6 px (radius kernel Gaussian
// bulat ke 0 -- kernel satu-tap [1.0], `blurLayersX/Y` jadi salinan murni),
// dan `grain_micro_structure_sigma` <= 0.05 (cabang eksplisit
// `microGenerate` menulis (1,1,1,1), `combine` mengalikan dengan identitas)
// -- SATU-SATUNYA sumber galat float yang mungkin ada adalah urutan operasi
// (blur radius-0 mengalikan bobot 1.0/1.0 secara eksplisit alih-alih
// tidak sama sekali), yang berada jauh di bawah ambang statistik Task 16
// (dikonfirmasi girang `grain.test.ts` tiga kasus lama tetap hijau, lih.
// task-16b-report.md).
//
// BINDING (sembilan compute pipeline dari SATU modul, masing-masing dapat
// bind group layout `auto` Dawn SENDIRI -- hanya mencakup binding yang
// benar-benar dirujuk entry point itu; semua di bawah 8 per pipeline):
//   generateLayers(): 0 src(read) / 1 layerRaw(write) / 2 params / 3 stock
//                     / 4 frameFloats                              [5]
//   blurLayersX():    1 layerRaw(read) / 5 layerBlurX(write) / 2 params
//                     / 3 stock / 4 frameFloats                    [5]
//   blurLayersY():    5 layerBlurX(read) / 6 layerSummed(write) / 2 params
//                     / 3 stock / 4 frameFloats                    [5]
//   microGenerate():  7 microRaw(write) / 2 params / 4 frameFloats [3]
//   microBlurX():     7 microRaw(read) / 8 microBlurXOut(write) / 2 params
//                     / 4 frameFloats                              [4]
//   microBlurY():     8 microBlurXOut(read) / 9 microBlurred(write)
//                     / 2 params / 4 frameFloats                   [4]
//   combine():        6 layerSummed(read) / 9 microBlurred(read)
//                     / 10 preBlur(write) / 2 params                [4]
//   blurX() (LAMA):   10 preBlur(read) / 11 blurXOut(write) / 2 params [3]
//   blurY() (LAMA):   11 blurXOut(read) / 12 dst(write) / 2 params    [3]

@group(0) @binding(0) var<storage, read> densityCmySrc: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> layerRaw: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: CoreParams;
@group(0) @binding(3) var<storage, read> stockArena: array<f32>;
@group(0) @binding(4) var<storage, read> frameFloats: array<f32>;
@group(0) @binding(5) var<storage, read_write> layerBlurX: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> layerSummed: array<vec4<f32>>;
@group(0) @binding(7) var<storage, read_write> microRaw: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read_write> microBlurXOut: array<vec4<f32>>;
@group(0) @binding(9) var<storage, read_write> microBlurred: array<vec4<f32>>;
@group(0) @binding(10) var<storage, read_write> preBlur: array<vec4<f32>>;
@group(0) @binding(11) var<storage, read_write> blurXOut: array<vec4<f32>>;
@group(0) @binding(12) var<storage, read_write> dst: array<vec4<f32>>;

const kFrameFilmPixelSizeUm: u32 = 0u;
// Fase 2C: `grainSeed` OFX (bilangan bulat disimpan f32, eksak sampai 2^24).
const kFrameGrainSeed: u32 = 1u;
// Fase 2C: `grainAmount` OFX (`SpektraGrain.comp::applyGrainControls`, saturasi 1).
const kFrameGrainAmount: u32 = 2u;

// Seed 1 (baseline) memberi salt 0, jadi realisasi Fase 1 tidak berubah.
fn seedSalt() -> u32 {
  return (u32(max(frameFloats[kFrameGrainSeed], 0.0)) - 1u) * 0x85ebca6bu;
}

// GrainParams default (params_schema.py:89-100) -- TIDAK PERNAH disentuh
// gen_reference.py untuk fixture yang gerbang ini pakai, jadi konstanta
// WGSL, bukan field CoreParams/arena.
const kParticleAreaUm2: f32 = 0.2;
const kParticleScale: vec3<f32> = vec3<f32>(1.6, 1.6, 3.2); // rgb
const kParticleScaleLayers: vec3<f32> = vec3<f32>(2.0, 1.0, 0.5); // sublayer
const kDensityMin: vec3<f32> = vec3<f32>(0.03, 0.03, 0.03); // rgb
const kUniformity: vec3<f32> = vec3<f32>(0.97, 0.99, 0.97); // rgb
const kGrainBlurSigma: f32 = 0.65;
// int(3.0*0.65 + 0.5) = 2 (`_gaussian_kernel_1d`, fast_gaussian_filter.py).
const kGrainBlurRadius: i32 = 2;
// Task 16b: `grain.blur_dye_clouds_um` (per-lapisan dye-cloud blur) dan
// `grain.micro_structure` (clumping lognormal) -- SAMA seperti kGrainBlur*
// di atas, TIDAK PERNAH disentuh gen_reference.py, jadi konstanta WGSL.
const kBlurDyeCloudsUm: f32 = 1.0;
const kMicroStructureBlurUm: f32 = 0.2; // grain_micro_structure[0]
const kMicroStructureSigmaNm: f32 = 30.0; // grain_micro_structure[1], dalam nm
const kBlurTruncate: f32 = 3.0; // fast_gaussian_filter default truncate

fn pixelSizeUm() -> f32 {
  return max(frameFloats[kFrameFilmPixelSizeUm], 1.0e-6);
}

fn densityCurveAt(i: u32, channel: u32) -> f32 {
  return stockArena[ARENA_DENSITYCURVES_OFFSET + i * 3u + channel];
}

// `densityCurveLayers` dibakar MENTAH (TIDAK dinormalisasi seperti
// `densityCurves`) -- Python meneruskan `density_curves_layers` apa adanya
// ke `apply_grain`, hanya sumbu pencarian (`densityCurves`) yang digeser
// nanmin-nya. Lih. blok komentar panjang `host/spectral.ts`.
fn densityCurveLayerAt(i: u32, sublayer: u32, channel: u32) -> f32 {
  return stockArena[ARENA_DENSITYCURVELAYERS_OFFSET + i * 9u + sublayer * 3u + channel];
}

fn densityCurveLayerMaximaAt(sublayer: u32, channel: u32) -> f32 {
  return stockArena[ARENA_DENSITYCURVELAYERMAXIMA_OFFSET + sublayer * 3u + channel];
}

// Port `interp_density_cmy_layers` (`model/density_curves.py:35-45`), cabang
// `positive_film=False` (satu-satunya yang fixture gerbang ini tempuh --
// `kodak_portra_400` adalah "negative"; cabang positif Python membalik
// tanda sebelum DAN sesudah interpolasi, TIDAK diimplementasikan di sini,
// sama seperti dir.ts/spectral.ts mencatat cabang positif DIR belum diuji).
fn interpDensityLayer(densityCmy: f32, channel: u32, sublayer: u32) -> f32 {
  let count = params.exposureCount;
  if (count == 0u) {
    return 0.0;
  }
  let firstX = densityCurveAt(0u, channel);
  let lastX = densityCurveAt(count - 1u, channel);
  if (densityCmy <= firstX) {
    return densityCurveLayerAt(0u, sublayer, channel);
  }
  if (densityCmy >= lastX) {
    return densityCurveLayerAt(count - 1u, sublayer, channel);
  }

  var lo: u32 = 0u;
  var hi: u32 = count - 1u;
  while (hi - lo > 1u) {
    let mid = (lo + hi) >> 1u;
    if (densityCurveAt(mid, channel) <= densityCmy) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  let x0 = densityCurveAt(lo, channel);
  let x1 = densityCurveAt(hi, channel);
  let y0 = densityCurveLayerAt(lo, sublayer, channel);
  let y1 = densityCurveLayerAt(hi, sublayer, channel);
  let dx = max(x1 - x0, 1.0e-9);
  let t = clamp((densityCmy - x0) / dx, 0.0, 1.0);
  return mix(y0, y1, t);
}

// Hash integer 32-bit (Thomas Wang) -- hanya butuh sebar statistik yang
// baik, TIDAK butuh cocok bit demi bit dengan RNG numba/scipy Python (lih.
// blok komentar modul: itu justru alasan gerbang ini statistik).
fn hash32(seed: u32) -> u32 {
  var x = seed;
  x = (x ^ 61u) ^ (x >> 16u);
  x = x + (x << 3u);
  x = x ^ (x >> 4u);
  x = x * 0x27d4eb2du;
  x = x ^ (x >> 15u);
  return x;
}

// Box-Muller: dua hash independen -> dua uniform(0,1) -> satu Normal(0,1).
// `u1` dijaga menjauh dari 0 supaya `log(u1)` tidak pernah -inf. `salt`
// membedakan stream RNG -- grain memakai sublayer asli (0..2), Task 16b
// memakai `salt=7u` (di luar rentang sublapisan sungguhan) untuk
// men-dekorelasi draw micro-structure dari draw grain layer.
fn randNormal(x: u32, y: u32, channel: u32, salt: u32) -> f32 {
  let a = hash32((x * 73856093u) ^ (y * 19349663u) ^ (channel * 83492791u) ^ (salt * 2654435761u) ^ seedSalt());
  let b = hash32(a ^ 0x9e3779b9u);
  let u1 = max(f32(a >> 8u) / 16777216.0, 1.0e-9);
  let u2 = f32(b >> 8u) / 16777216.0;
  return sqrt(-2.0 * log(u1)) * cos(6.283185307179586 * u2);
}

fn reflectIndex(i: i32, n: i32) -> u32 {
  if (i >= 0 && i < n) {
    return u32(i);
  }
  if (i >= -n && i < 0) {
    return u32(-i - 1);
  }
  if (i >= n && i < 2 * n) {
    return u32(2 * n - 1 - i);
  }
  let period = 2 * n;
  var m = i % period;
  if (m < 0) {
    m += period;
  }
  if (m >= n) {
    m = period - 1 - m;
  }
  return u32(m);
}

fn activeBounds(gid: vec2<u32>) -> bool {
  let activeWidth = select(params.width, params.activeWidth, params.activeWidth != 0u);
  let activeHeight = select(params.height, params.activeHeight, params.activeHeight != 0u);
  return gid.x < activeWidth && gid.y < activeHeight;
}

fn gaussianWeightSigma(offset: i32, sigma: f32) -> f32 {
  let x = f32(offset) / max(sigma, 1.0e-6);
  return exp(-0.5 * x * x);
}

// `int(truncate*sigma + 0.5)` -- `_gaussian_kernel_1d` (fast_gaussian_filter.py).
fn kernelRadius(sigma: f32) -> i32 {
  return i32(kBlurTruncate * sigma + 0.5);
}

// --- per-(kanal,sublapisan) konstanta turunan `od_particle` -- SAMA formula
// Task 16, faktor bersama antara `generateLayers` (mu/variance) dan
// `blurLayersX/Y` (sigma blur_particle) -- lih. `grain.ts` untuk kenapa ini
// dihitung per-pixel di shader alih-alih di-bake ke arena. ---
struct LayerConst {
  fraction: f32,
  densityMinLayer: f32,
  densityMaxShifted: f32,
  odParticle: f32,
}

fn layerConst(channel: u32, sublayer: u32, pixelAreaUm2: f32) -> LayerConst {
  var densityMaxTotal: f32 = 0.0;
  for (var sl: u32 = 0u; sl < 3u; sl = sl + 1u) {
    densityMaxTotal += densityCurveLayerMaximaAt(sl, channel);
  }
  let maxima = densityCurveLayerMaximaAt(sublayer, channel);
  let fraction = maxima / max(densityMaxTotal, 1.0e-12);
  let densityMinLayer = fraction * kDensityMin[channel];
  let densityMaxShifted = maxima + densityMinLayer;
  let particleAreaLayer = kParticleAreaUm2 * kParticleScale[channel] * kParticleScaleLayers[sublayer];
  let n = (pixelAreaUm2 * fraction) / max(particleAreaLayer, 1.0e-12);
  let odParticle = densityMaxShifted / max(n, 1.0e-12);
  var out: LayerConst;
  out.fraction = fraction;
  out.densityMinLayer = densityMinLayer;
  out.densityMaxShifted = densityMaxShifted;
  out.odParticle = odParticle;
  return out;
}

// Task 16b: sigma `blur_particle` per (kanal,sublapisan) --
// `blur_dye_clouds_um*sqrt(od_particle)` (`layer_particle_model`,
// `grain.py:48-50`). TIDAK ada ambang aktivasi eksplisit di Python untuk
// suku ini (beda dengan micro-structure di bawah) -- `fast_gaussian_filter`
// sendiri no-op (`if sigma<=0: return copy`) dan `_gaussian_kernel_1d`
// membulatkan radius ke 0 (kernel satu-tap identitas) untuk sigma kecil,
// jadi SELF-REGULATING benar meniru Python di sini (lih. blok komentar
// modul untuk kenapa micro-structure TIDAK boleh memakai pola yang sama).
fn layerBlurSigma(channel: u32, sublayer: u32, pixelAreaUm2: f32) -> f32 {
  let lc = layerConst(channel, sublayer, pixelAreaUm2);
  return kBlurDyeCloudsUm * sqrt(lc.odParticle);
}

// Port `apply_grain_to_density_layers` (`model/grain.py:112-163`) TANPA
// blur -- menulis sampel Normal analitik MENTAH per (piksel,kanal,
// sublapisan) ke `layerRaw` (indeks `pixelIndex*3u+sublapisan`).
// `blurLayersX/Y` mem-blur dan menjumlahkan sublapisan SETELAHNYA (lih.
// blok komentar modul untuk kenapa urutannya HARUS begini -- blur_particle
// beda sigma per sublapisan, jadi blur dan penjumlahan lintas sublapisan
// TIDAK bisa dipertukarkan).
@compute @workgroup_size(32, 8, 1)
fn generateLayers(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (!activeBounds(gid.xy)) {
    return;
  }
  let absoluteGid = gid.xy + vec2<u32>(params.activeOriginX, params.activeOriginY);
  if (absoluteGid.x >= params.width || absoluteGid.y >= params.height) {
    return;
  }
  let index = absoluteGid.y * params.width + absoluteGid.x;
  let src = densityCmySrc[index];
  let densityCmy = src.rgb;

  // Task 19b: seed RNG dari koordinat ABSOLUT gambar penuh (`tileGid`),
  // BUKAN `absoluteGid` (lokal-buffer) -- lih. penjelasan panjang identik
  // di riwayat git modul ini / task-16-report.md untuk bukti langsung lewat
  // gerbang bit-identik Task 19b.
  let tileGid = absoluteGid + vec2<u32>(params.tileOriginX, params.tileOriginY);

  let pxUm = pixelSizeUm();
  let pixelAreaUm2 = pxUm * pxUm;

  for (var sl: u32 = 0u; sl < 3u; sl = sl + 1u) {
    var outVec = vec3<f32>(0.0);
    for (var ch: u32 = 0u; ch < 3u; ch = ch + 1u) {
      let lc = layerConst(ch, sl, pixelAreaUm2);
      let layerValue = interpDensityLayer(densityCmy[ch], ch, sl) + lc.densityMinLayer;
      let p = clamp(layerValue / max(lc.densityMaxShifted, 1.0e-12), 1.0e-6, 1.0 - 1.0e-6);
      let saturation = 1.0 - p * kUniformity[ch] * (1.0 - 1.0e-6);
      let mu = p * lc.densityMaxShifted;
      let variance = max(p * lc.densityMaxShifted * lc.odParticle * saturation, 0.0);
      outVec[ch] = mu + sqrt(variance) * randNormal(tileGid.x, tileGid.y, ch, sl);
    }
    layerRaw[index * 3u + sl] = vec4<f32>(outVec, 1.0);
  }
}

@compute @workgroup_size(32, 8, 1)
fn blurLayersX(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let x = i32(gid.x);
  let pxUm = pixelSizeUm();
  let pixelAreaUm2 = pxUm * pxUm;
  let index = gid.y * params.width + gid.x;

  for (var sl: u32 = 0u; sl < 3u; sl = sl + 1u) {
    var acc = vec3<f32>(0.0);
    for (var ch: u32 = 0u; ch < 3u; ch = ch + 1u) {
      let sigma = layerBlurSigma(ch, sl, pixelAreaUm2);
      let radius = kernelRadius(sigma);
      var sum: f32 = 0.0;
      var weightSum: f32 = 0.0;
      for (var k: i32 = -radius; k <= radius; k = k + 1) {
        let sx = reflectIndex(x + k, i32(params.width));
        let w = gaussianWeightSigma(k, sigma);
        sum += layerRaw[(gid.y * params.width + sx) * 3u + sl][ch] * w;
        weightSum += w;
      }
      acc[ch] = sum / max(weightSum, 1.0e-8);
    }
    layerBlurX[index * 3u + sl] = vec4<f32>(acc, 1.0);
  }
}

@compute @workgroup_size(32, 8, 1)
fn blurLayersY(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let y = i32(gid.y);
  let pxUm = pixelSizeUm();
  let pixelAreaUm2 = pxUm * pxUm;
  let index = gid.y * params.width + gid.x;

  var total = vec3<f32>(0.0);
  for (var sl: u32 = 0u; sl < 3u; sl = sl + 1u) {
    var acc = vec3<f32>(0.0);
    for (var ch: u32 = 0u; ch < 3u; ch = ch + 1u) {
      let sigma = layerBlurSigma(ch, sl, pixelAreaUm2);
      let radius = kernelRadius(sigma);
      var sum: f32 = 0.0;
      var weightSum: f32 = 0.0;
      for (var k: i32 = -radius; k <= radius; k = k + 1) {
        let sy = reflectIndex(y + k, i32(params.height));
        let w = gaussianWeightSigma(k, sigma);
        sum += layerBlurX[(sy * params.width + gid.x) * 3u + sl][ch] * w;
        weightSum += w;
      }
      acc[ch] = sum / max(weightSum, 1.0e-8);
    }
    total += acc;
  }
  layerSummed[index] = vec4<f32>(total, 1.0);
}

// Port `add_micro_structure` (`model/grain.py:53-64`) tahap 1: field
// lognormal IID mean=1 per (piksel,kanal) -- `fast_lognormal_from_mean_std`
// dengan `mean=1,std=grain_micro_structure_sigma`
// (`sigma_ln=sqrt(ln(1+std^2))`, `mu_ln=-sigma_ln^2/2` karena `ln(mean)=0`).
// Cabang `if grain_micro_structure_sigma>0.05` diport SEBAGAI CABANG
// (`select`), BUKAN mengandalkan sigma->0 self-regulating -- lih. blok
// komentar modul.
@compute @workgroup_size(32, 8, 1)
fn microGenerate(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let absoluteGid = gid.xy + vec2<u32>(params.activeOriginX, params.activeOriginY);
  let tileGid = absoluteGid + vec2<u32>(params.tileOriginX, params.tileOriginY);
  let pxUm = pixelSizeUm();
  let microSigma = kMicroStructureSigmaNm * 0.001 / pxUm;
  let index = gid.y * params.width + gid.x;

  if (microSigma <= 0.05) {
    microRaw[index] = vec4<f32>(1.0, 1.0, 1.0, 1.0);
    return;
  }

  let sigmaLn = sqrt(log(1.0 + microSigma * microSigma));
  let muLn = -0.5 * sigmaLn * sigmaLn;
  var clumping = vec3<f32>(0.0);
  for (var ch: u32 = 0u; ch < 3u; ch = ch + 1u) {
    // salt=7u: di luar rentang sublapisan asli (0..2) -- dekorelasi dari
    // draw `generateLayers` (lih. blok komentar `randNormal`).
    let z = randNormal(tileGid.x, tileGid.y, ch, 7u);
    clumping[ch] = exp(muLn + sigmaLn * z);
  }
  microRaw[index] = vec4<f32>(clumping, 1.0);
}

// `add_micro_structure` tahap 2: blur field clumping (SATU sigma skalar
// untuk ketiga kanal, `grain_micro_structure_blur_pixel = micro_structure[0]
// /pixel_size_um` -- BEDA dari blur_particle yang sigma-nya per-kanal).
// Cabang `if grain_micro_structure_blur_pixel>0.4` diport SEBAGAI CABANG
// EKSPLISIT (radius dipaksa 0 kalau cabang mati) -- lih. blok komentar
// modul untuk kenapa self-regulating SALAH di sini (ambang 0.4 lebih tinggi
// dari titik kernel Gaussian mana pun sudah ber-radius nonzero).
fn microBlurRadius(pxUm: f32) -> i32 {
  let microBlurPixel = kMicroStructureBlurUm / pxUm;
  if (microBlurPixel <= 0.4) {
    return 0;
  }
  return kernelRadius(microBlurPixel);
}

@compute @workgroup_size(32, 8, 1)
fn microBlurX(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let x = i32(gid.x);
  let pxUm = pixelSizeUm();
  let microBlurPixel = kMicroStructureBlurUm / pxUm;
  let radius = microBlurRadius(pxUm);
  var acc = vec4<f32>(0.0);
  var weightSum: f32 = 0.0;
  for (var k: i32 = -radius; k <= radius; k = k + 1) {
    let sx = reflectIndex(x + k, i32(params.width));
    let w = gaussianWeightSigma(k, microBlurPixel);
    acc += microRaw[gid.y * params.width + sx] * w;
    weightSum += w;
  }
  microBlurXOut[gid.y * params.width + gid.x] = acc / max(weightSum, 1.0e-8);
}

@compute @workgroup_size(32, 8, 1)
fn microBlurY(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let y = i32(gid.y);
  let pxUm = pixelSizeUm();
  let microBlurPixel = kMicroStructureBlurUm / pxUm;
  let radius = microBlurRadius(pxUm);
  var acc = vec4<f32>(0.0);
  var weightSum: f32 = 0.0;
  for (var k: i32 = -radius; k <= radius; k = k + 1) {
    let sy = reflectIndex(y + k, i32(params.height));
    let w = gaussianWeightSigma(k, microBlurPixel);
    acc += microBlurXOut[sy * params.width + gid.x] * w;
    weightSum += w;
  }
  microBlurred[gid.y * params.width + gid.x] = acc / max(weightSum, 1.0e-8);
}

// `density_cmy_out = add_micro_structure(...)`; `density_cmy_out -=
// density_min` -- titik masuk yang SAMA dengan keluaran lama `generate()`,
// dikonsumsi TIDAK BERUBAH oleh `blurX`/`blurY` (grain_blur=0.65) di bawah.
@compute @workgroup_size(32, 8, 1)
fn combine(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (!activeBounds(gid.xy)) {
    return;
  }
  let absoluteGid = gid.xy + vec2<u32>(params.activeOriginX, params.activeOriginY);
  if (absoluteGid.x >= params.width || absoluteGid.y >= params.height) {
    return;
  }
  let index = absoluteGid.y * params.width + absoluteGid.x;
  let summed = layerSummed[index].rgb;
  let clump = microBlurred[index].rgb;
  preBlur[index] = vec4<f32>(summed * clump - kDensityMin, 1.0);
}

// `fast_gaussian_filter(density_cmy_out, grain_blur=0.65)` -- TIDAK BERUBAH
// dari Task 16 (lih. berkas ini di riwayat git untuk versi asli).
fn gaussianWeight(offset: i32) -> f32 {
  let x = f32(offset) / kGrainBlurSigma;
  return exp(-0.5 * x * x);
}

@compute @workgroup_size(32, 8, 1)
fn blurX(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let x = i32(gid.x);
  var acc = vec4<f32>(0.0);
  var weightSum: f32 = 0.0;
  for (var k: i32 = -kGrainBlurRadius; k <= kGrainBlurRadius; k = k + 1) {
    let sx = reflectIndex(x + k, i32(params.width));
    let w = gaussianWeight(k);
    acc += preBlur[gid.y * params.width + sx] * w;
    weightSum += w;
  }
  blurXOut[gid.y * params.width + gid.x] = acc / max(weightSum, 1.0e-8);
}

@compute @workgroup_size(32, 8, 1)
fn blurY(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let y = i32(gid.y);
  var acc = vec4<f32>(0.0);
  var weightSum: f32 = 0.0;
  for (var k: i32 = -kGrainBlurRadius; k <= kGrainBlurRadius; k = k + 1) {
    let sy = reflectIndex(y + k, i32(params.height));
    let w = gaussianWeight(k);
    acc += blurXOut[sy * params.width + gid.x] * w;
    weightSum += w;
  }
  let index = gid.y * params.width + gid.x;
  let grained = max((acc / max(weightSum, 1.0e-8)).rgb, vec3<f32>(0.0));
  // Fase 2C: `applyGrainControls` OFX -- `base + (grained - base) * amount`,
  // setelah blur densitas akhir (kOpDensityBlurY -> kOpApplyControls). Amount
  // 1 memakai `grained` apa adanya: Python tidak punya amount.
  let amount = max(frameFloats[kFrameGrainAmount], 0.0);
  var out = grained;
  if (amount != 1.0) {
    let base = densityCmySrc[index].rgb;
    out = max(base + (grained - base) * amount, vec3<f32>(0.0));
  }
  dst[index] = vec4<f32>(out, blurXOut[index].a);
}
