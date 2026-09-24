// Transliterasi $SPEKTRAFILM_PY/src/spektrafilm/model/grain.py (bukan
// $SPEKTRAFILM_OFX/shaders/vulkan/SpektraGrain.comp, 1.183 baris) -- lih.
// Global Constraints/koreksi Task 15: hulu punya DUA implementasi dan yang
// mengikat kita adalah Python. Grain adalah pasangan paling divergen di
// seluruh proyek (numba/scipy RNG vs 1183 baris GLSL); shader OFX hanya
// dipakai untuk mengecek konvensi buffer scratch, bukan sebagai sumber
// algoritma. Menutup gerbang STATISTIK (mean/varians/spektrum daya radial,
// ambang 1e-4, spec §6.5) pada tap `cmy_film`, keluarga fixture
// `_stochastic` -- BUKAN gerbang per-piksel. Alasannya BUKAN karena Python
// acak (dengan `fixed_seed=None`, `grain.py:84-87` menyetel `seed=[0,1,2]`,
// jadi Python sendiri deterministik antar-run -- task-16-report.md), tapi
// karena RNG WGSL di sini adalah ALGORITMA BERBEDA dari numba/scipy Python:
// dua implementasi yang sama-sama benar menghasilkan realisasi butir
// berbeda pada piksel yang sama dengan statistik yang sama. JANGAN naikkan
// ini jadi gerbang per-piksel dan JANGAN longgarkan toleransi statistik.
//
// TEMUAN KUNCI (dibuktikan, bukan diasumsikan -- lih. task-16-report.md):
// `GrainParams.sublayers_active` default `True` (params_schema.py:91), dan
// `apply_grain` (`model/grain.py:166-191`) mencabang PADA FLAG ITU, bukan
// pada `n_sub_layers` -- `n_sub_layers` (default 1) HANYA dibaca di dalam
// `apply_grain_to_density`, cabang non-layers yang `sublayers_active=True`
// TIDAK PERNAH mencapai. Jadi model grain PRODUKSI yang sesungguhnya untuk
// setiap fixture di gerbang ini adalah `apply_grain_to_density_layers`
// (grain.py:112-163, "experimental" menurut komentarnya sendiri, tapi itu
// yang default sungguhan jalankan) -- BUKAN `apply_grain_to_density`.
//
// PENYEDERHANAAN ANALITIK (dibuktikan numerik di task-16-report.md dan
// scratchpad host-side JS sebelum berkas ini ditulis, BUKAN pendekatan yang
// diperkenalkan sendiri menyimpang dari Python): `layer_particle_model`
// Python men-draw `seeds ~ Poisson(n/saturation)` lalu
// `grain ~ Binomial(seeds, p)`. Untuk n_particles_per_pixel SEBESAR yang
// gerbang ini pakai (1e5..1e7, dari pixel_size_um mikrofilm 546..4375 um --
// dihitung di `grain.ts`), teorema PENIPISAN POISSON (Poisson thinning)
// membuat komposisi itu SAMA PERSIS dengan `Poisson(n*p/saturation)` --
// bukan aproksimasi, itu identitas distribusi eksak. Untuk lambda sebesar
// itu, `Normal(lambda, sqrt(lambda))` juga esensial eksak (persis regime
// yang `fast_poisson`/`fast_binomial` Python SENDIRI beralih ke aproksimasi
// Normal, `utils/fast_stats.py`, walau jalur produksi nyatanya lewat scipy
// karena `settings.use_fast_stats=False` -- keduanya menyasar distribusi
// yang SAMA, cuma algoritma RNG-nya beda, yang justru fakta yang membuat
// gerbang ini statistik). Setelah disederhanakan (n membatalkan
// `od_particle=density_max/n`):
//
//   mu    = probabilityOfDevelopment * densityMax          (median, EKSAK)
//   sigma = sqrt(probabilityOfDevelopment * densityMax * odParticle * saturation)
//
// diikuti sampel Normal 1x per (kanal, sublapisan) alih-alih simulasi
// Poisson-Binomial dua tahap -- distribusi akhirnya identik, cuma jalur
// RNG-nya lebih pendek. Angka gerbang lengkap ada di task-16-report.md.
//
// DIABAIKAN, DIBUKTIKAN AMAN UNTUK FIXTURE INI (bukan diasumsikan seperti
// boost_highlights/lens_blur Task 14/15 -- CATATAN: keduanya TIDAK
// pixel-size-dependent, tapi dua suku di bawah INI YA -- lih. peringatan di
// `grain.ts`):
//   - `blur_particle` (per-lapisan-per-kanal "dye cloud" blur,
//     `grain_blur_dye_clouds_um=1.0` default): sigma = blur_particle *
//     sqrt(od_particle). Untuk pixel_size_um fixture ini (546..4375 um,
//     gambar uji 8x8..64x64px), od_particle ~1e-6..1e-8, sigma ~5e-4..3e-3
//     -- jauh di bawah ambang aktivasi Python `blur_particle*sqrt(od_particle)
//     > 0.4` (lih. `layer_particle_model`), jadi NO-OP TERBUKTI untuk
//     seluruh fixture yang gerbang ini uji.
//   - `add_micro_structure` (clumping lognormal + blur, `micro_structure=
//     (0.2, 30)` default): `grain_micro_structure_sigma = 30*0.001/
//     pixel_size_um` ~7e-6..5e-5, jauh di bawah ambang aktivasi `>0.05` --
//     NO-OP TERBUKTI juga.
//   Keduanya BERGANTUNG pixel_size_um (beda dengan boost_highlights/lens_
//   blur yang nol dari default param, titik) -- gambar resolusi tinggi
//   sungguhan (pixel_size_um jauh lebih kecil) bisa membuat keduanya aktif.
//   Task mendatang yang menutup gerbang pada gambar beresolusi produksi
//   HARUS menghitung ulang, bukan mewarisi asumsi "selalu nol" ini.
//   - `apply_grain_to_density` (cabang non-layers): TIDAK PERNAH dipanggil
//     untuk `sublayers_active=True` default -- tidak diimplementasikan.
//   - `bypass_grain`: parameter fungsi, tidak pernah `True` di jalur
//     `gen_reference.py` manapun -- tidak diwire ke CoreParams.
//   - `use_fast_stats`: tidak relevan -- penyederhanaan analitik di atas
//     valid utk kedua nilai (scipy DAN fast_stats sama-sama menyasar
//     Poisson(n/sat) menyusun Binomial(.,p), keduanya SAMA distribusi
//     limitnya untuk n sebesar ini).
//
// BINDING (tiga entry point, TIGA compute pipeline dari SATU modul --
// masing-masing dapat bind group layout `auto` sendiri dari Dawn, hanya
// mencakup binding yang benar-benar dirujuk entry point itu; lih. grain.ts):
//   generate(): 0 densityCmySrc(read) / 1 preBlur(read_write) / 2 params
//               (uniform) / 3 stockArena(read) / 4 frameFloats(read,
//               pixel_size_um)
//   blurX():    1 preBlur(read) / 5 blurXOut(read_write) / 2 params
//   blurY():    5 blurXOut(read) / 6 dst(read_write) / 2 params
// Tujuh binding total, di bawah batas 8 -- TIDAK ada buffer filler/junk yang
// dibutuhkan (beda dengan halation.wgsl) karena setiap entry point sudah
// hanya merujuk perannya sendiri, tidak ada aliasing writable ganda dalam
// satu dispatch.

@group(0) @binding(0) var<storage, read> densityCmySrc: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> preBlur: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: CoreParams;
@group(0) @binding(3) var<storage, read> stockArena: array<f32>;
@group(0) @binding(4) var<storage, read> frameFloats: array<f32>;
@group(0) @binding(5) var<storage, read_write> blurXOut: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> dst: array<vec4<f32>>;

const kFrameFilmPixelSizeUm: u32 = 0u;

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

fn pixelSizeUm() -> f32 {
  return max(frameFloats[kFrameFilmPixelSizeUm], 1.0e-6);
}

fn densityCurveAt(i: u32, channel: u32) -> f32 {
  return stockArena[ARENA_DENSITYCURVES_OFFSET + i * 3u + channel];
}

// `densityCurveLayers` dibakar MENTAH (TIDAK dinormalisasi seperti
// `densityCurves`) -- Python meneruskan `density_curves_layers` apa adanya
// ke `apply_grain`, hanya sumbu pencarian (`densityCurves`) yang digeser
// nanmin-nya. Lih. blok komentar `host/spectral.ts`.
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
// Mencari `densityCmy` (nilai densitas keseluruhan, BUKAN log-exposure) di
// `densityCurves[:,channel]` (sumbu-x, sudah ternormalisasi & naik monoton)
// lalu menginterpolasi `densityCurveLayers[:,sublayer,channel]` (sumbu-y).
// Gaya pencarian biner SAMA PERSIS `interpDensityCurve` (curveDevelop.wgsl)
// -- hanya sumbu pencariannya beda (nilai densitas, bukan log-exposure).
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
// `u1` dijaga menjauh dari 0 supaya `log(u1)` tidak pernah -inf.
fn randNormal(x: u32, y: u32, channel: u32, sublayer: u32) -> f32 {
  let a = hash32((x * 73856093u) ^ (y * 19349663u) ^ (channel * 83492791u) ^ (sublayer * 2654435761u));
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

// Port `apply_grain_to_density_layers` (`model/grain.py:112-163`) MINUS
// `add_micro_structure` (no-op terbukti, lih. blok komentar modul) dan MINUS
// `blur_particle` per-lapisan (no-op terbukti juga). Menulis
// `density_cmy_out` PRA-BLUR (sebelum `fast_gaussian_filter(..., grain_blur)`
// akhir, yang dilakukan `blurX`/`blurY`).
@compute @workgroup_size(32, 8, 1)
fn generate(@builtin(global_invocation_id) gid: vec3<u32>) {
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

  // Task 19b: `tileGid` -- posisi PIKSEL SEBENARNYA pada gambar PENUH,
  // PERSIS pola `filmExposure.wgsl:243` (`tileGid = absoluteGid +
  // tileOrigin`). `absoluteGid` di atas (di SEMUA shader tahap ini, lih.
  // `params.ts`) hanya LOKAL ke buffer tile ini -- benar untuk indexing
  // `densityCmySrc`/`preBlur` (yang memang berlayout tile-lokal), TAPI
  // `randNormal` di bawah memakai (x,y) sebagai SEED spasial deterministik
  // (hash posisi, lih. blok komentar `randNormal`), yang HARUS sama untuk
  // piksel yang sama pada gambar PENUH terlepas tile mana yang memuatnya --
  // persis semantik `apply_grain_to_density_layers` Python, yang mengindeks
  // array gambar UTUH (tidak ada konsep tile sama sekali). Memakai
  // `absoluteGid` (buffer-lokal) di sini akan memberi SEED YANG BERBEDA
  // untuk piksel yang sama tergantung `tileOriginX/Y` tile yang memuatnya --
  // dibuktikan langsung lewat gerbang bit-identik Task 19b (tiled vs
  // full-frame, keduanya WGSL yang SAMA): residual kecil (~1e-3..1e-2)
  // tersebar di SELURUH frame, persis pola noise spasial yang seed-nya
  // bergeser, BUKAN pita tipis di seam (yang berarti apron kurang) --
  // hilang total setelah `tileGid` dipakai di sini.
  let tileGid = absoluteGid + vec2<u32>(params.tileOriginX, params.tileOriginY);

  // --- konstanta per-(sublapisan,kanal), BERGANTUNG pixel_size_um (per-run,
  // bukan per-stock) -- lih. `grain.ts` untuk kenapa ini dihitung per-pixel
  // di sini alih-alih di-bake ke arena (sembilan nilai skalar, biaya ALU
  // dapat diabaikan dibanding biaya baca arena; menghindari kebutuhan
  // arena/scratch tambahan yang menyimpan hasil turunan per-lebar-gambar). ---
  let pxUm = pixelSizeUm();
  let pixelAreaUm2 = pxUm * pxUm;

  var densityMaxTotal = vec3<f32>(0.0);
  for (var sl: u32 = 0u; sl < 3u; sl = sl + 1u) {
    densityMaxTotal += vec3<f32>(
      densityCurveLayerMaximaAt(sl, 0u),
      densityCurveLayerMaximaAt(sl, 1u),
      densityCurveLayerMaximaAt(sl, 2u),
    );
  }

  var out = vec3<f32>(0.0);
  for (var ch: u32 = 0u; ch < 3u; ch = ch + 1u) {
    var sum: f32 = 0.0;
    for (var sl: u32 = 0u; sl < 3u; sl = sl + 1u) {
      let maxima = densityCurveLayerMaximaAt(sl, ch);
      let fraction = maxima / max(densityMaxTotal[ch], 1.0e-12);
      let densityMinLayer = fraction * kDensityMin[ch];
      let densityMaxShifted = maxima + densityMinLayer;

      let particleAreaLayer = kParticleAreaUm2 * kParticleScale[ch] * kParticleScaleLayers[sl];
      let n = (pixelAreaUm2 * fraction) / max(particleAreaLayer, 1.0e-12);
      let odParticle = densityMaxShifted / max(n, 1.0e-12);

      let layerValue = interpDensityLayer(densityCmy[ch], ch, sl) + densityMinLayer;
      let probabilityOfDevelopment = clamp(layerValue / max(densityMaxShifted, 1.0e-12), 1.0e-6, 1.0 - 1.0e-6);
      let saturation = 1.0 - probabilityOfDevelopment * kUniformity[ch] * (1.0 - 1.0e-6);

      // Penyederhanaan analitik (lih. blok komentar modul): thinning Poisson
      // eksak + aproksimasi Normal pada lambda besar.
      let mu = probabilityOfDevelopment * densityMaxShifted;
      let variance = max(probabilityOfDevelopment * densityMaxShifted * odParticle * saturation, 0.0);
      let sample = mu + sqrt(variance) * randNormal(tileGid.x, tileGid.y, ch, sl);
      sum += sample;
    }
    out[ch] = sum - kDensityMin[ch];
  }

  preBlur[index] = vec4<f32>(out, src.a);
}

// `fast_gaussian_filter(density_cmy_out, grain_blur)` -- lulus X dulu
// (`_fir_2d_fused` Python melakukan vertikal-lalu-horizontal dalam SATU
// fungsi ber-strip, tapi hasil akhirnya SAMA dengan dua lulus terpisah
// horizontal-lalu-vertikal manapun karena kernel separable dan simetris;
// urutan X-lalu-Y di sini SAMA dengan gaya `gaussianSampleX`/`Y`
// halation.wgsl). Padding REFLECT (`scipy.ndimage` mode='reflect', fungsi
// `_reflect` `fast_gaussian_filter.py`) -- BUKAN clamp seperti `safeIndex`
// halation.wgsl, yang aman di sana HANYA karena sigma-nya selalu underflow
// ke radius 0 pada fixture kecil. Di sini `kGrainBlurRadius=2` selalu aktif
// (sigma tetap 0.65, TIDAK bergantung pixel_size_um), jadi batas benar-benar
// tersentuh dan reflect HARUS diimplementasikan persis.
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
  let y = i32(gid.y);
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
  let x = i32(gid.x);
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
  dst[index] = vec4<f32>(max((acc / max(weightSum, 1.0e-8)).rgb, vec3<f32>(0.0)), blurXOut[index].a);
}
