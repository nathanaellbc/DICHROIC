// Task 18: transliterasi `ScanningStage.scan()` Python
// (`$SPEKTRAFILM_PY/src/spektrafilm/runtime/stages/scanning.py:46-50`),
// tap `rgb_out` -- `_density_to_rgb` (cabang `io.scan_film=False`, mencetak
// PRINT) -> `_apply_blur_and_unsharp` -> `_apply_cctf_encoding`.
//
// CAKUPAN gerbang `_lut` (Gate A; lih. `addScannerPostDynamicData`,
// `src/host/spectral.ts`, untuk bukti penuh per istilah): di bawah
// `lut_mode`, glare (stokastik) mati, `scanner.lens_blur=0` (sudah nol
// bahkan di default), `scanner.unsharp_mask=(0,0)`, dan `white_correction`/
// `black_correction` KEDUANYA `False` -- jadi rangkaian
// `density -> XYZ (spektral) -> RGB linear (scanToOutputRgb) ->
// compress_rgb (CAM16-UCS) -> CCTF encode (analitik sRGB)` cukup, TANPA
// unsharp (`scanPreUnsharp`/`unsharpBlurX`/`unsharpBlurY` tetap berjalan
// tapi bertindak sebagai identitas -- gerbang eksplisit lewat `FLAG_
// UNSHARP_ACTIVE` (bit 3 slot1, `src/engine/params.ts`), PERSIS pola
// `FLAG_GLARE_ACTIVE` di atas: dispatch blur TETAP jalan (murah, gambar
// uji kecil), tapi `scan()` membuang kontribusinya lewat `select()` saat
// bit itu padam -- Python `if sigma>0 and amount>0` benar-benar TIDAK
// memanggil `apply_unsharp_mask` untuk `lut_mode`, jadi port ini HARUS
// dicabang juga, bukan cuma "kebetulan identitas").
//
// GATE B (Task 18, keluarga `_stochastic`, gerbang STATISTIK via
// `moments()`) menambahkan `add_glare` -- TIGA dispatch tambahan
// (`glareGenerate`->`glareBlurX`->`glareBlurY`) yang berjalan SEBELUM
// `scanPreUnsharp`, menulis medan derau lognormal-terblur ke
// `glareBlurred`, yang `scanPreUnsharp` baca dan tambahkan ke `xyz`
// SEBELUM `scanToOutputRgb` -- lih. blok komentar "Task 18 Gate B" di
// bawah untuk derivasi lengkap. `black_white_xyz_correction` TETAP no-op
// TERBUKTI untuk SEMUA fixture gerbang ini (`white_correction`/
// `black_correction` default `False`, tidak satu pun disentuh
// `gen_reference.py`).
//
// TASK 18c: `_apply_blur_and_unsharp` (`scanner.unsharp_mask`) TERNYATA
// BUKAN no-op untuk keluarga fixture `measured` BIASA (draf lama komentar
// ini SALAH mengklaim "no-op untuk SEMUA fixture gerbang ini") -- HANYA
// benar untuk `_lut`/`_stochastic` (nihil untuk keduanya, lih. paragraf di
// atas). Lih. blok komentar Task 18c di dekat binding 8-11 (`preUnsharp`/
// `unsharpBlurXOut`/`unsharpBlurred`/`unsharpKernel`) untuk audit penuh.
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
//   `scannerToOutputRgb` (3x3, `sRGB`), `scannerIlluminantXyz` (Task 18
//   Gate B, 3 skalar -- `contract("k,kl->l", scan_illuminant,
//   STANDARD_OBSERVER_CMFS[:]) / normalization`, `add_glare`'s
//   `illuminant_xyz`), `scannerCam16Viewing` (8 skalar: D_RGB.xyz, F_L,
//   N_bb, z, A_w, n), `scannerCam16CmaxTable` (64x720, `C_max(Jp,h)`,
//   dibangun host `buildCam16UcsGamutTable`).
@group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: CoreParams;
@group(0) @binding(3) var<storage, read> staticArena: array<f32>;
@group(0) @binding(4) var<storage, read> dynamicArena: array<f32>;
// Task 18 Gate B (glare, `add_glare` / `compute_random_glare_amount`,
// `model/glare.py`) -- tiga scratch skalar (satu float per piksel, BUKAN
// vec4 seperti `src`/`dst`: `compute_random_glare_amount` menghasilkan
// SATU medan derau lognormal per gambar, dibagi rata ke tiga kanal XYZ
// lewat perkalian `illuminant_xyz`, bukan derau per-kanal) untuk pola
// generate->blurX->blurY TIGA-pipeline yang SAMA dengan `grain.wgsl`
// (lih. blok komentar di sana): setiap entry point di bawah hanya
// merujuk binding yang benar-benar ia pakai, jadi `layout: 'auto'`
// menghasilkan bind group layout PER-PIPELINE yang genuinely disjoint --
// TIDAK ADA buffer read_write yang di-alias dua kali dalam satu dispatch
// (persis peringatan Hard Constraints soal validasi Dawn), dan setiap
// pipeline individual jauh di bawah batas 8 storage buffer per shader
// stage (`scan` sendiri: 0,1,3,4,7 = 5 storage + 1 uniform).
@group(0) @binding(5) var<storage, read_write> glarePreBlur: array<f32>;
@group(0) @binding(6) var<storage, read_write> glareBlurXOut: array<f32>;
@group(0) @binding(7) var<storage, read_write> glareBlurred: array<f32>;

// Task 18c: `_apply_blur_and_unsharp` (`scanning.py:123-128`) TERNYATA
// BUKAN no-op untuk keluarga fixture `measured` BIASA (draf lama komentar
// berkas ini, dan `scannerPost.ts`, SALAH mengklaim "TERBUKTI no-op untuk
// KEDUA keluarga") -- dibuktikan lewat gerbang deterministik baru
// `measuredChain.test.ts` (`rgb_out` memerahkan max abs error 1.8 untuk
// `color_patches`, TIDAK berubah oleh perbaikan DIR/glare terpisah) dan
// dikonfirmasi LANGSUNG dari `params_builder.py::digest_params`:
// `scanner.unsharp_mask` (default `(0.7, 0.7)`, `params_schema.py:85`)
// HANYA dinolkan oleh `debug.lut_mode`/`deactivate_spatial_effects`
// (baris 92/118/138) -- BUKAN oleh `deactivate_stochastic_effects` (yang
// hanya mematikan grain/glare, `params_builder.py:140-142`). Gate A
// (`_lut`) dan Gate B (`_stochastic`) TIDAK PERNAH menyalakannya
// (`lut_mode` untuk Gate A; `_stochastic` TIDAK mempromosikan
// `deactivate_spatial_effects`, TAPI Gate B hanya menguji STATISTIK
// `rgb_out`, yang menyerap unsharp-nya ke dalam varians/spektrum-daya
// tanpa memerahkan gerbang mean/variance-nya sendiri) -- gerbang
// deterministik `measuredChain.test.ts` adalah yang PERTAMA menguji
// `rgb_out` per-piksel pada keluarga di mana istilah ini benar-benar hidup.
//
// `scanner.lens_blur` (default `0.0`, `params_schema.py:80`) TETAP no-op
// TERBUKTI (`apply_gaussian_blur`, `model/diffusion.py:81-88`, `if sigma>0`
// -- tidak pernah `True` untuk fixture manapun di repo ini) -- HANYA
// `unsharp_mask` yang diport di bawah.
//
// `apply_unsharp_mask` (`model/diffusion.py:6-19`) Python: `blurred =
// fast_gaussian_filter(rgb, sigma)`; `sharp = rgb + amount*(rgb-blurred)`
// -- `sigma=amount=0.7`, KONSTANTA (tidak pernah disentuh preset stock
// manapun, SAMA pola pembuktian `halation.wgsl`/`dir.wgsl`). PENTING:
// `sigma` di sini dipakai LANGSUNG sebagai piksel (Python TIDAK membagi
// dengan `pixel_size_um` di titik ini -- beda dari DIR/Halation/Diffusion,
// `scanning.py` tidak punya akses `pixel_size_um` sama sekali), jadi
// `radius = int(3.0*0.7+0.5) = 2` -- SELALU 5-tap, TIDAK PERNAH identitas,
// tidak seperti Gaussian dasar DIR (lih. `dir.wgsl`) yang sering identik
// untuk fixture kecil ini.
//
// Kernel dihitung host (JS/f64, PERSIS `_gaussian_kernel_1d` Python) dan
// diunggah sebagai bobot konkret -- SAMA alasan `dir.wgsl` (hindari risiko
// ULP transcendental WGSL, lih. blok komentar di sana) -- `reflectIndex`
// di sini juga port literal `fast_gaussian_filter.py::_reflect` yang SAMA.
//
// Diterapkan pada `rgbCompressed` (KELUARAN `compress_rgb`, SEBELUM
// `_apply_cctf_encoding`) -- PERSIS urutan `ScanningStage.scan()` Python
// (`_density_to_rgb` -> `_apply_blur_and_unsharp` -> `_apply_cctf_
// encoding`). Butuh SATU dispatch tambahan sebelum unsharp (`scanPreUnsharp`,
// menghitung `rgbCompressed` per-piksel dan menyimpannya ke `preUnsharp`)
// karena unsharp butuh TETANGGA, sedangkan sisa `scan()` murni per-piksel --
// pola SAMA `halation.wgsl`/`dir.wgsl` (hitung medan mentah, blur X lalu Y,
// resolve).
@group(0) @binding(8) var<storage, read_write> preUnsharp: array<vec4<f32>>;
@group(0) @binding(9) var<storage, read_write> unsharpBlurXOut: array<vec4<f32>>;
@group(0) @binding(10) var<storage, read_write> unsharpBlurred: array<vec4<f32>>;
@group(0) @binding(11) var<storage, read> unsharpKernel: array<f32>;

// Fase 2C: per render (`FrameParams`), dibaca HANYA `scan` (x) dan `glareGenerate` (y):
//   x = `scanner.unsharp_mask[1]` (amount; sigma tetap 0.7),
//   y = mu lognormal glare = ln(percent) - sigma2/2 (`fast_lognormal_from_mean_std`).
@group(0) @binding(12) var<uniform> scannerFrame: vec4<f32>;
const kUnsharpMaxRadius: i32 = 16; // lih. dir.wgsl::kMaxKernelRadius -- headroom jauh di atas radius terpakai (2).

fn unsharpKernelRadius() -> i32 {
  return i32(unsharpKernel[0]);
}

fn unsharpKernelWeight(offset: i32) -> f32 {
  return unsharpKernel[1 + offset + kUnsharpMaxRadius];
}

// Port literal `fast_gaussian_filter.py::_reflect` -- lih. dokumentasi
// identik `dir.wgsl::reflectIndex` (duplikasi disengaja, tiap shader di
// repo ini berdiri sendiri).
fn unsharpReflectIndex(i: i32, n: i32) -> i32 {
  if (i >= 0 && i < n) { return i; }
  if (i >= -n && i < 0) { return -i - 1; }
  if (i >= n && i < 2 * n) { return 2 * n - 1 - i; }
  let period = 2 * n;
  var m = i % period;
  if (m < 0) { m = m + period; }
  if (m >= n) { m = period - 1 - m; }
  return m;
}

const kLog10E: f32 = 0.4342944819032518;

// ============================================================================
// density -> XYZ spektral (`cmy_to_log_xyz`, `compute_density_spectral` +
// `density_to_light`, port sama seperti `printScan.wgsl`, arena berbeda).
// ============================================================================

// NaN dideteksi dari POLA BIT nilai yang baru dibaca dari arena, bukan dengan
// `x != x`: WGSL mengizinkan compiler menganggap float tidak pernah NaN
// (fast-math), dan lavapipe maupun SwiftShader memang melipat `x != x` jadi
// `false`. NaN lalu merambat, eksposur print runtuh ke ~0 (`log_e_print` ~ -10)
// dan gambar keluar hitam -- hanya backend yang kebetulan tidak melipatnya
// (D3D12/NVIDIA) yang lolos gerbang. Operasi integer pada nilai hasil load
// tidak bisa dilipat dengan asumsi itu; aritmetika tidak pernah menyentuh NaN.
fn isNanBits(x: f32) -> bool {
  return (bitcast<u32>(x) & 0x7fffffffu) > 0x7f800000u;
}

// `compute_density_spectral` + `density_to_light` (NaN -> 0), sama seperti
// `printScan.wgsl::spectralLight` tetapi atas densitas kertas di `dynamicArena`.
fn spectralLight(cmy: vec3<f32>, wl: u32, lightAtWavelength: f32) -> f32 {
  let o = ARENA_SCANNERCHANNELDENSITY_OFFSET + wl * 3u;
  let c0 = dynamicArena[o];
  let c1 = dynamicArena[o + 1u];
  let c2 = dynamicArena[o + 2u];
  let base = dynamicArena[ARENA_SCANNERBASEDENSITY_OFFSET + wl];
  if (isNanBits(c0) || isNanBits(c1) || isNanBits(c2) || isNanBits(base)) {
    return 0.0;
  }
  let density = cmy.r * c0 + cmy.g * c1 + cmy.b * c2 + base;
  return pow(10.0, -density) * lightAtWavelength;
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
    let illuminantAtWavelength = dynamicArena[ARENA_SCANNERILLUMINANT_OFFSET + wl];
    let light = spectralLight(cmy, wl, illuminantAtWavelength);
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
// Task 18 Gate B -- `add_glare` / `compute_random_glare_amount`
// (`model/glare.py`), tap `rgb_out`, keluarga fixture `_stochastic`. Gerbang
// STATISTIK (`moments()`, `test/parity/statistics.ts`, ambang 1e-4, spec
// §6.5), BUKAN per-piksel -- alasan IDENTIK dengan Task 16 (grain.wgsl):
// kernel numba `@njit(parallel=True)` Python memanggil `np.random.randn()`
// di dalam `prange`, RNG paralel yang state-nya tidak bisa di-seed lewat
// field params manapun, jadi RNG WGSL di sini SELALU algoritma berbeda --
// dua implementasi yang sama-sama benar menghasilkan realisasi derau
// berbeda pada piksel yang sama dengan statistik yang sama.
//
// `GlareParams` default (`params_schema.py:116-121`) -- TIDAK PERNAH
// disentuh `gen_reference.py` untuk fixture manapun (dibuktikan lewat
// `params_builder.py::digest_params`: `deactivate_stochastic_effects`
// mematikan `active`, `lut_mode`/`deactivate_spatial_effects` menekan
// `blur` ke 0 -- TIDAK SATU PUN diaktifkan untuk keluarga `_stochastic`),
// jadi konstanta WGSL, persis pola `kDensityMin`/`kUniformity` di
// `grain.wgsl`:
//   active=True, percent=0.03, roughness=0.7, blur=0.5
//
// `compute_random_glare_amount(amount, roughness, blur, shape)`:
//   1. `fast_lognormal_from_mean_std(mean=amount, std=roughness*amount)` --
//      SATU derau lognormal SKALAR per piksel (bukan per-kanal: dipakai
//      lewat `glare_amount[:,:,None] * illuminant_xyz[None,None,:]`,
//      dibagi rata ke tiga kanal XYZ oleh whitepoint illuminant, BUKAN
//      digambar ulang per kanal seperti grain). `s/m = roughness` (m
//      membatalkan), jadi `sigma2 = ln(1+roughness^2)` TIDAK bergantung
//      `percent` -- dihitung sekali sebagai konstanta di bawah.
//   2. `fast_gaussian_filter(random_glare, blur)` -- Gaussian terpisah
//      (X lalu Y), `truncate=3.0` DEFAULT (Python TIDAK pernah mengoper
//      truncate lain di sini), radius = `int(3.0*0.5+0.5) = 2`. Padding
//      REFLECT (`scipy.ndimage` mode='reflect'), SAMA `reflectIndex`
//      `grain.wgsl` -- diduplikasi di sini (bukan diimpor) karena setiap
//      berkas WGSL proyek ini berdiri sendiri (lih. `grain.wgsl`,
//      `halation.wgsl`: tidak ada modul util bersama yang di-concat).
//   3. `/= 100` -- diterapkan SETELAH blur (linear, komutatif dengan blur
//      terboboti-rata secara aljabar; diterapkan di titik yang SAMA
//      Python, `glareBlurY`, bukan lebih awal, supaya urutan operasi tetap
//      terbaca 1:1 terhadap `glare.py`).
// ============================================================================

const kGlareRoughness: f32 = 0.7;
const kGlareBlurSigma: f32 = 0.5;
// int(3.0*0.5 + 0.5) = 2 (`_gaussian_kernel_1d`, fast_gaussian_filter.py).
const kGlareBlurRadius: i32 = 2;
// sigma2 = ln(1 + roughness^2) = ln(1.49); sigma = sqrt(sigma2);
// mu = ln(percent) - sigma2/2 bergantung `glarePercent`, jadi sejak Fase 2C
// dihitung host per render (`glareLogMu`, `stages/scannerPost.ts`) dan
// dibaca dari `scannerFrame.y`. sigma tidak bergantung percent (s/m = roughness).
const kGlareLogSigma: f32 = 0.6314872286573718;

fn illuminantXyz() -> vec3<f32> {
  let o = ARENA_SCANNERILLUMINANTXYZ_OFFSET;
  return vec3<f32>(dynamicArena[o], dynamicArena[o + 1u], dynamicArena[o + 2u]);
}

fn glareHash32(seed: u32) -> u32 {
  var x = seed;
  x = (x ^ 61u) ^ (x >> 16u);
  x = x + (x << 3u);
  x = x ^ (x >> 4u);
  x = x * 0x27d4eb2du;
  x = x ^ (x >> 15u);
  return x;
}

// Box-Muller, SATU sampel Normal(0,1) per piksel (bukan per-kanal/
// sublapisan seperti `grain.wgsl::randNormal` -- lih. blok komentar
// modul). Salt (`0xB5297A4Du`) sengaja BERBEDA dari `grain.wgsl` supaya
// dua medan stokastik ini tidak berbagi state RNG kalau file ini dan
// grain suatu hari disatukan -- tidak dibutuhkan untuk kebenaran statistik
// (dua stream independen mana pun cukup), murni kebersihan.
fn glareRandNormal(x: u32, y: u32) -> f32 {
  let a = glareHash32((x * 73856093u) ^ (y * 19349663u) ^ 0xB5297A4Du);
  let b = glareHash32(a ^ 0x9e3779b9u);
  let u1 = max(f32(a >> 8u) / 16777216.0, 1.0e-9);
  let u2 = f32(b >> 8u) / 16777216.0;
  return sqrt(-2.0 * log(u1)) * cos(6.283185307179586 * u2);
}

fn glareReflectIndex(i: i32, n: i32) -> u32 {
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

fn glareGaussianWeight(offset: i32) -> f32 {
  let x = f32(offset) / kGlareBlurSigma;
  return exp(-0.5 * x * x);
}

fn glareActiveBounds(gid: vec2<u32>) -> bool {
  let activeWidth = select(params.width, params.activeWidth, params.activeWidth != 0u);
  let activeHeight = select(params.height, params.activeHeight, params.activeHeight != 0u);
  return gid.x < activeWidth && gid.y < activeHeight;
}

// `random_glare = fast_lognormal_from_mean_std(...)`, PRA-blur. Sama
// keterbatasan tiling yang `grain.wgsl::generate` catat: hanya menulis
// sub-rektangel aktif; `glareBlurX`/`glareBlurY` membaca lewat SELURUH
// buffer untuk refleksi tepi yang benar -- fixture gerbang ini selalu
// `activeWidth=activeHeight=0` ("seluruh buffer"), jadi tidak
// termanifestasi di sini.
@compute @workgroup_size(32, 8, 1)
fn glareGenerate(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (!glareActiveBounds(gid.xy)) {
    return;
  }
  let absoluteGid = gid.xy + vec2<u32>(params.activeOriginX, params.activeOriginY);
  if (absoluteGid.x >= params.width || absoluteGid.y >= params.height) {
    return;
  }
  let index = absoluteGid.y * params.width + absoluteGid.x;
  // Task 19b: `tileGid` -- posisi piksel SEBENARNYA pada gambar PENUH,
  // PERSIS fix `grain.wgsl::generate` (lih. komentar panjang di sana) dan
  // pola `filmExposure.wgsl:243`. `glareRandNormal` di bawah adalah SEED
  // spasial deterministik (hash posisi) -- memakai `absoluteGid` (LOKAL ke
  // buffer tile ini, lih. `params.ts`) akan memberi seed berbeda untuk
  // piksel yang sama tergantung tile yang memuatnya.
  let tileGid = absoluteGid + vec2<u32>(params.tileOriginX, params.tileOriginY);
  let z = glareRandNormal(tileGid.x, tileGid.y);
  glarePreBlur[index] = exp(scannerFrame.y + kGlareLogSigma * z);
}

@compute @workgroup_size(32, 8, 1)
fn glareBlurX(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let x = i32(gid.x);
  var acc: f32 = 0.0;
  var weightSum: f32 = 0.0;
  for (var k: i32 = -kGlareBlurRadius; k <= kGlareBlurRadius; k = k + 1) {
    let sx = glareReflectIndex(x + k, i32(params.width));
    let w = glareGaussianWeight(k);
    acc += glarePreBlur[gid.y * params.width + sx] * w;
    weightSum += w;
  }
  glareBlurXOut[gid.y * params.width + gid.x] = acc / max(weightSum, 1.0e-8);
}

@compute @workgroup_size(32, 8, 1)
fn glareBlurY(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.width || gid.y >= params.height) {
    return;
  }
  let y = i32(gid.y);
  var acc: f32 = 0.0;
  var weightSum: f32 = 0.0;
  for (var k: i32 = -kGlareBlurRadius; k <= kGlareBlurRadius; k = k + 1) {
    let sy = glareReflectIndex(y + k, i32(params.height));
    let w = glareGaussianWeight(k);
    acc += glareBlurXOut[sy * params.width + gid.x] * w;
    weightSum += w;
  }
  let index = gid.y * params.width + gid.x;
  glareBlurred[index] = (acc / max(weightSum, 1.0e-8)) / 100.0;
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

// `sin()`/`cos()` GPU (Dawn/Tint, backend native) DIUKUR jauh lebih tidak
// akurat daripada lantai f32 biasa pada argumen yang benar-benar muncul di
// rantai CAM16-UCS ini -- probe langsung (task-18d, pointwise DAN scan
// rentang penuh) terhadap device SUNGGUHAN, dibandingkan `Math.sin`/
// `Math.cos` f64: `sin(hp)` pada argumen piksel gagal SUNGGUHAN
// (`color_patches`, piksel 3) menyimpang **4.14e-6** absolut (`cos` pada
// argumen sama: 3.27e-8, jauh lebih kecil -- TIDAK simetris, jadi bukan
// artefak pembulatan generik); scan rentang [-pi,pi] menemukan galat
// absolut sampai **~3.1-3.2e-5** dekat siku kuadran (`sin` dekat x=pi/2,
// `cos` dekat x=pi), 30-260x lantai f32 `pow`/`sqrt`/`log` yang diukur di
// probe SAMA (~1e-7-1e-8, TIDAK diindikasikan -- lih. `zzdiag-obj1-
// logprobe.test.ts` di riwayat commit sesi ini, dihapus sebelum commit).
// Mekanisme: `xyzToCam16Ucs` membentuk `ap=Mp*cos(hRad)`, `bp=Mp*sin(hRad)`
// dari SATU sudut lalu memulihkan `Cp=sqrt(ap^2+bp^2)` -- identitas
// Pythagoras HANYA berlaku sampai presisi `cos^2+sin^2`, dan errornya TIDAK
// saling meniadakan karena `sin`/`cos` native diukur TIDAK simetris. Ini
// PERSIS menjelaskan galat relatif Cp ~4e-6 yang diukur pada piksel gagal
// gerbang `rgb_out`/`color_patches` (task-18d) -- >>lantai `atan2Accurate`
// (~1e-7 rad) yang SUDAH menutup Gate A, jadi bukan regresi dari perbaikan
// itu, sumber BARU yang gerbang `measured`/`rgb_out` (Task 18c) yang
// pertama kali mengekspos (Gate A/`_lut` tidak pernah punya kombinasi
// argumen yang sama).
//
// Polinomial minimax (least-squares titik-Chebyshev, derajat 13 untuk
// `sin` / derajat 12 untuk `cos`, dalam `x^2`, `fit_sincos.mjs`, dihapus
// sebelum commit) TERVERIFIKASI di JS terhadap `Math.sin`/`Math.cos` di
// SELURUH `[-pi,pi]` (500rb titik uji, BUKAN cuma titik fit): `sin` maks
// abs `3.17e-8`, `cos` maks abs `4.19e-8` -- >100x lebih akurat dari
// `sin`/`cos` native yang diukur, mendarat di lantai f32 yang SAMA seperti
// `pow`/`sqrt`/`log` (yang TIDAK diganti -- tidak diindikasikan). Reduksi
// rentang standar (`x - 2*pi*round(x/(2*pi))`, `round()` WGSL EKSAK --
// bukan transcendental berpendekatan) karena argumen di sini bisa melebihi
// `[-pi,pi]` (`cos(2.0+hRad)`).
const kSincosTwoPi: f32 = 6.283185307179586;

fn reduceAngle(x: f32) -> f32 {
  return x - kSincosTwoPi * round(x / kSincosTwoPi);
}

fn sinPoly(xReduced: f32) -> f32 {
  let t = xReduced * xReduced;
  var p = 1.3641326881872822e-10;
  p = p * t - 2.4737625785798427e-8;
  p = p * t + 0.0000027536898774867102;
  p = p * t - 0.00019840593095742174;
  p = p * t + 0.008333322864236287;
  p = p * t - 0.16666666095169105;
  p = p * t + 0.9999999996796889;
  return xReduced * p;
}

fn cosPoly(xReduced: f32) -> f32 {
  let t = xReduced * xReduced;
  var p = 1.7293474033268572e-9;
  p = p * t - 2.7094024444600663e-7;
  p = p * t + 0.000024771650680491882;
  p = p * t - 0.0013887901766899415;
  p = p * t + 0.041666514874552245;
  p = p * t - 0.49999991779253355;
  p = p * t + 0.9999999954468125;
  return p;
}

fn sinAccurate(x: f32) -> f32 {
  return sinPoly(reduceAngle(x));
}

fn cosAccurate(x: f32) -> f32 {
  return cosPoly(reduceAngle(x));
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
// `colour.RGB_COLOURSPACES[output].matrix_RGB_to_XYZ`/`matrix_XYZ_to_RGB`
// APA ADANYA (untuk sRGB: konstanta TERBIT independen, BUKAN sepasang invers
// -- lih. blok komentar berkas). Fase 2C Task 9: dibaca dari arena dynamic
// (`scannerOutput*`, baris-mayor) per colour space keluaran; dulu konstanta
// sRGB di sini. WGSL `mat3x3` kolom-mayor: baris jadi KOLOM.
fn outputMatrix(base: u32) -> mat3x3<f32> {
  return mat3x3<f32>(
    vec3<f32>(dynamicArena[base], dynamicArena[base + 3u], dynamicArena[base + 6u]),
    vec3<f32>(dynamicArena[base + 1u], dynamicArena[base + 4u], dynamicArena[base + 7u]),
    vec3<f32>(dynamicArena[base + 2u], dynamicArena[base + 5u], dynamicArena[base + 8u]),
  );
}
fn outputRgbToXyz() -> mat3x3<f32> {
  return outputMatrix(ARENA_SCANNEROUTPUTRGBTOXYZ_OFFSET);
}
fn outputXyzToRgb() -> mat3x3<f32> {
  return outputMatrix(ARENA_SCANNEROUTPUTXYZTORGB_OFFSET);
}

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
  let e_t = 0.25 * (cosAccurate(2.0 + hRad) + 3.8);
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
  let e_t = 0.25 * (cosAccurate(2.0 + hRad) + 3.8);
  let Jsafe = max(J, 1.0e-9);
  let t = spow(C / (sqrt(Jsafe / 100.0) * pow(1.64 - pow(0.29, vc.n), 0.73)), 1.0 / 0.9);
  let A = vc.A_w * spow(J / 100.0, 1.0 / (kSurroundC * vc.z));
  let P2 = A / vc.N_bb + 0.305;

  var a = 0.0;
  var b = 0.0;
  if (t != 0.0) {
    let P1 = ((50000.0 / 13.0) * kSurroundNc * vc.N_bb * e_t) / t;
    let P3 = 21.0 / 20.0;
    let sinH = sinAccurate(hRad);
    let cosH = cosAccurate(hRad);
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
  return vec3<f32>(Jp, Mp * cosAccurate(hRad), Mp * sinAccurate(hRad));
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
  let xyz = outputRgbToXyz() * rgbLinear;
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
  let apNew = CpNew * cosAccurate(hp);
  let bpNew = CpNew * sinAccurate(hp);

  let xyzNew = cam16UcsToXyz(jab.x, apNew, bpNew, vc);
  return outputXyzToRgb() * xyzNew;
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

// Fase 2C Task 9: `cctf_encoding` colour space keluaran, jenis dari
// `scannerOutputEncoding` (lih. `bake_web_assets.py::_python_output_color_spaces`,
// dideteksi numerik): 0 linear, 1 sRGB (IEC 61966-2-1), 2 ROMM (ProPhoto:
// `16v` di bawah 1/512, `v**(1/1.8)`), 3 gamma `v**(1/g)`.
fn outputEncode(v: f32) -> f32 {
  let kind = u32(dynamicArena[ARENA_SCANNEROUTPUTENCODING_OFFSET]);
  if (kind == 1u) {
    return srgbEncode(v);
  }
  if (kind == 2u) {
    if (v < 1.0 / 512.0) {
      return 16.0 * v;
    }
    return spow(v, 1.0 / 1.8);
  }
  if (kind == 3u) {
    return spow(v, 1.0 / dynamicArena[ARENA_SCANNEROUTPUTENCODING_OFFSET + 1u]);
  }
  return v;
}

fn applyCctfEncoding(rgbCompressed: vec3<f32>) -> vec3<f32> {
  let xyz = outputRgbToXyz() * rgbCompressed;
  let rgb2 = outputXyzToRgb() * xyz;
  return vec3<f32>(outputEncode(rgb2.x), outputEncode(rgb2.y), outputEncode(rgb2.z));
}

// Batas aktif SAMA di keempat entry point di bawah (`scanPreUnsharp`,
// `unsharpBlurX`, `unsharpBlurY`, `scan`) -- diduplikasi (bukan fungsi
// bersama) PERSIS pola `halation.wgsl`/`dir.wgsl`'s `main()`, karena WGSL
// tidak punya cara murah membagi guard ini lintas entry point berbeda.
fn withinActiveBounds(gid: vec3<u32>) -> bool {
  let activeWidth = select(params.width, params.activeWidth, params.activeWidth != 0u);
  let activeHeight = select(params.height, params.activeHeight, params.activeHeight != 0u);
  return gid.x < activeWidth && gid.y < activeHeight;
}

fn absoluteIndex(gid: vec3<u32>) -> u32 {
  let absoluteGid = gid.xy + vec2<u32>(params.activeOriginX, params.activeOriginY);
  return absoluteGid.y * params.width + absoluteGid.x;
}

fn inFullBounds(gid: vec3<u32>) -> bool {
  let absoluteGid = gid.xy + vec2<u32>(params.activeOriginX, params.activeOriginY);
  return absoluteGid.x < params.width && absoluteGid.y < params.height;
}

// Paruh PERTAMA `ScanningStage.scan()`/`_density_to_rgb` Python (Task 18c:
// dipecah dari `scan()` lama supaya `unsharpBlurX`/`unsharpBlurY` di bawah
// punya medan `rgbCompressed` PENUH -- BUKAN log_e/density -- untuk
// dikonvolusi, PERSIS `_apply_blur_and_unsharp` Python yang menerima
// `rgb` linear KELUARAN `compress_rgb`, bukan `density_channels` mentah).
// Menulis `preUnsharp[index]` (murni per-piksel, TIDAK butuh tetangga).
@compute @workgroup_size(32, 8, 1)
fn scanPreUnsharp(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (!withinActiveBounds(gid) || !inFullBounds(gid)) {
    return;
  }
  let index = absoluteIndex(gid);
  let cmyPrint = src[index];
  if (scannerFrame.z == 1.0) {
    let glareOn = (params.slot1 & 4u) != 0u;
    preUnsharp[index] = vec4<f32>(cmyPrint.rgb + select(0.0, glareBlurred[index], glareOn), cmyPrint.a);
    return;
  }
  let xyz = densityToXyz(cmyPrint.rgb);
  // `black_white_xyz_correction`: identitas (`white_correction`/
  // `black_correction` KEDUANYA `False`, lih. blok komentar berkas).
  // `add_glare` (Task 18 Gate B): `xyz + glare_amount * illuminant_xyz`,
  // TEPAT sebelum `XYZ_to_RGB` -- `glareBlurred[index]` sudah di-blur DAN
  // dibagi 100 oleh `glareGenerate`->`glareBlurX`->`glareBlurY` (tiga
  // dispatch terpisah, dijalankan SEBELUM pass ini oleh `scannerPost.ts`).
  // Bit 2 slot1 (`FLAG_GLARE_ACTIVE`, `src/engine/params.ts`) mencerminkan
  // `print_render.glare.active` Python: PADAM untuk keluarga `_lut`
  // (`lut_mode` memaksa `deactivate_stochastic_effects=True`), MENYALA
  // untuk `_stochastic` -- `add_glare` Python sendiri `return xyz` identik
  // (tidak menambah apa pun) ketika `glare.active` `False`, jadi cabang
  // ini WAJIB, bukan opsional: TANPA-nya tiga dispatch glare akan
  // mengotori Gate A (`_lut`, per-piksel, 1e-6) dengan derau yang Python
  // tidak pernah terapkan untuk fixture itu.
  let glareOn = (params.slot1 & 4u) != 0u;
  let xyzGlared = select(xyz, xyz + glareBlurred[index] * illuminantXyz(), glareOn);
  let rgbLinear = scanToOutputRgb(xyzGlared);

  let vc = loadCam16Viewing();
  let rgbCompressed = compressRgbCam16Ucs(rgbLinear, vc);

  preUnsharp[index] = vec4<f32>(rgbCompressed, cmyPrint.a);
}

fn sampleUnsharpSourceX(x: i32, y: i32) -> vec4<f32> {
  let sx = unsharpReflectIndex(x, i32(params.width));
  let sy = unsharpReflectIndex(y, i32(params.height));
  return preUnsharp[u32(sy) * params.width + u32(sx)];
}

// Pass X (Task 18c): `fast_gaussian_filter` separable -- lih. blok komentar
// binding 8-11 untuk kenapa kernelnya dihitung host, bukan `exp()` WGSL.
@compute @workgroup_size(32, 8, 1)
fn unsharpBlurX(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (!withinActiveBounds(gid) || !inFullBounds(gid)) {
    return;
  }
  let absoluteGid = gid.xy + vec2<u32>(params.activeOriginX, params.activeOriginY);
  let index = absoluteGid.y * params.width + absoluteGid.x;
  let x = i32(absoluteGid.x);
  let y = i32(absoluteGid.y);
  let radius = unsharpKernelRadius();
  var acc = vec4<f32>(0.0);
  for (var o: i32 = -radius; o <= radius; o = o + 1) {
    acc += sampleUnsharpSourceX(x + o, y) * unsharpKernelWeight(o);
  }
  unsharpBlurXOut[index] = acc;
}

fn sampleUnsharpSourceY(x: i32, y: i32) -> vec4<f32> {
  let sx = unsharpReflectIndex(x, i32(params.width));
  let sy = unsharpReflectIndex(y, i32(params.height));
  return unsharpBlurXOut[u32(sy) * params.width + u32(sx)];
}

@compute @workgroup_size(32, 8, 1)
fn unsharpBlurY(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (!withinActiveBounds(gid) || !inFullBounds(gid)) {
    return;
  }
  let absoluteGid = gid.xy + vec2<u32>(params.activeOriginX, params.activeOriginY);
  let index = absoluteGid.y * params.width + absoluteGid.x;
  let x = i32(absoluteGid.x);
  let y = i32(absoluteGid.y);
  let radius = unsharpKernelRadius();
  var acc = vec4<f32>(0.0);
  for (var o: i32 = -radius; o <= radius; o = o + 1) {
    acc += sampleUnsharpSourceY(x, y + o) * unsharpKernelWeight(o);
  }
  unsharpBlurred[index] = acc;
}

// Paruh KEDUA `ScanningStage.scan()` Python -- `_apply_blur_and_unsharp`
// (`image + amount*(image-blurred)`, gerbang lewat `FLAG_UNSHARP_ACTIVE`,
// lih. blok komentar binding 8-11) lalu `_apply_cctf_encoding`.
@compute @workgroup_size(32, 8, 1)
fn scan(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (!withinActiveBounds(gid) || !inFullBounds(gid)) {
    return;
  }
  let index = absoluteIndex(gid);
  let pre = preUnsharp[index];
  let unsharpOn = (params.slot1 & 8u) != 0u;
  let sharpened = select(pre.rgb, pre.rgb + scannerFrame.x * (pre.rgb - unsharpBlurred[index].rgb), unsharpOn);

  let rgbEncoded = applyCctfEncoding(sharpened);

  dst[index] = vec4<f32>(rgbEncoded, pre.a);
}
