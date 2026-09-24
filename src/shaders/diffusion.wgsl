// Task 15 (resumed after BLOCKED): diffusion-filter stage, ported from
// $SPEKTRAFILM_PY/src/spektrafilm/model/diffusion.py::apply_diffusion_filter_um
// (:585-639), NOT from $SPEKTRAFILM_OFX/shaders/vulkan/SpektraDiffusion.comp's
// downsample/blur/upsample pyramid dispatcher.
//
// WHY NOT THE OFX PYRAMID: SpektraDiffusion.comp decomposes each PSF
// sub-lambda into a 3-Gaussian mixture (the same `kExpGaussianFit` table
// Halation uses) and runs it through a downsample-blur-upsample pyramid.
// That is an approximation belonging to the OFX GPU shader, NOT to Python
// -- Python's own `apply_diffusion_filter_um` does an EXACT
// `scipy.signal.fftconvolve` against an analytic multi-exponential PSF
// (`diffusion_filter_psf`). The prior implementer measured the
// OFX-faithful surrogate directly against real Python output and found
// 7.38e-4 to 1.273e-1 error -- 70x to 12,700x over the 1e-5 gate tolerance,
// with the error ratio to p_s CONSTANT per family (no strength choice
// separates "visible effect" from "passes the gate"). See
// task-15-report.md for the full measurement. Since Python itself uses no
// approximation here, spec §6.3.1 ("Python wins") forbids introducing one
// on the GPU side just because OFX's shader does.
//
// WHAT THIS SHADER ACTUALLY DOES: `fftconvolve` against a FINITE kernel is
// mathematically identical to a direct spatial convolution against that
// same kernel (FFT convolution is an exact algorithm, not an
// approximation) -- verified by reimplementing this exact function in
// JS/f64 against Python's real output BEFORE this file was written,
// landing at ~1e-14 (f64 machine-precision noise), see
// `src/host/diffusionFilter.ts` and task-15-report.md. So this shader is a
// single direct 2D convolution: for every pixel, sum a precomputed
// per-channel kernel (`diffusionFilter.ts::precomputeDiffusionFilter`,
// baked host-side into the `dynamic` arena by
// `src/host/spectral.ts::precomputeArenaData` -- MUST run before
// `acquireDevice()`, see the long comment there) against `reflect`-padded
// neighbourhood samples, then blends with the identity by the
// energy-conserving scatter fraction:
//
//   E_out = (1 - p_s) * E_in  +  p_s * (K_s * E_in)
//
// exactly Python's convex combination. No pyramid, no multi-dispatch, no
// `slot0`/`slot1`/`slot2` op codes -- this is architecturally simpler than
// SpektraDiffusion.comp because it isn't trying to be a fast approximation;
// "quality over performance" (project rule) makes the O(kernelPixels)
// per-pixel cost acceptable. Kernel sizes stay small at fixture scale
// (radius capped by Python itself at `min(image.shape[:2])//2 - 1`) -- see
// `diffusionFilter.ts` for the exact numbers this task's fixtures use.
//
// PSF SYMMETRY: `diffusion_filter_psf` is radially symmetric per channel
// (`psf == psf[::-1,::-1]`, verified rtol=atol=0 for all four families in
// the host-math check), so convolution and correlation coincide here --
// this shader does a correlation (kernel indexed the same way in both
// directions), which is only correct for a symmetric kernel. Do not reuse
// this code for an asymmetric kernel without flipping the kernel index.
//
// ARENA LAYOUT (dynamic arena, Task 15 additions -- see spectral.ts):
//   `diffusionRadius{Camera,Print}`         -- 1 float, kernel radius (int-valued).
//   `diffusionScatterFraction{Camera,Print}` -- 1 float, p_s.
//   `diffusionPsf{Camera,Print}`            -- (2r+1)*(2r+1)*3 floats,
//     C-order (y*kernelWidth+x)*3+channel, sum-normalised per channel --
//     exactly Python's `diffusion_filter_psf` return layout.
// `diffusion.ts` textually substitutes the site-specific offset constant
// names below (camera vs print) before compiling this source, since
// WebGPU has no runtime "which arena entry" indirection cheaper than
// picking the right compile-time offset.
//
// BINDING (4 total, well under the 8-storage-buffer limit):
//   0: srcPixels  (read)       -- `ctx.source`, raw LINEAR film exposure
//      (FilmExposure ran with slot0=1 for this chain -- see
//      `test/parity/params.ts::defaultCoreParams`, family 'measured').
//   1: dstPixels  (read_write) -- `ctx.dest`.
//   2: params     (uniform CoreParams) -- only width/height/active*/full*
//      are read; this stage needs no slot0/1/2 (single dispatch, no
//      multi-pass op selector).
//   3: dynamicArena (read) -- `arenas.dynamic.buffer`.
@group(0) @binding(0) var<storage, read> srcPixels: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> dstPixels: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: CoreParams;
@group(0) @binding(3) var<storage, read> dynamicArena: array<f32>;

// Task 17 debt (gerbang enlarger diffusion): `diffusion.ts` mensubstitusi
// `__DIFFUSION_FINAL_LOG__` menjadi `true` untuk `site: 'print'` dan
// `false` untuk `site: 'camera'` -- SATU-SATUNYA perbedaan perilaku antar
// situs selain nama offset arena (lih. komentar berkas di atas). Kamera
// TETAP `false`: `halation.wgsl`-lah yang men-`log10`-kan hasil gabungan
// scatter+diffusion sebagai dispatch TERAKHIRNYA (`kOpBounceResolveLog`),
// PERSIS seperti sebelumnya (Task 15) -- tidak berubah sama sekali. Print
// menjadi `true`: TIDAK ADA tahap lain setelah diffusion(print) di rantai
// `PrintingStage.expose()` -- diffusion inilah dispatch spasial TERAKHIR
// sebelum tap `log_e_print`, jadi ia yang harus menutup `log10` tunggal
// yang Python jalankan di akhir `expose()`, PERSIS pola `slot0==1u`
// `filmExposure.wgsl`/`printScan.wgsl` (raw linear disimpan justru supaya
// SATU tahap hilir bisa menyelesaikan log10-nya sendiri) yang instruksi
// tugas ini secara eksplisit minta dipakai ulang, bukan diciptakan
// mekanisme kedua.
const kApplyFinalLog: bool = __DIFFUSION_FINAL_LOG__;
// Task 18 Gate B: `createDiffusionStage(..., { bypassConvolution: true })`
// substitutes `true` here for the generic `family: 'measured'`/`_stochastic`
// chain (`test/parity/chain.ts::fullChain`), where BOTH
// `camera.diffusion_filter.active` and `enlarger.diffusion_filter.active`
// default to `False` in Python (`params_schema.py`, `DiffusionFilterParams.
// active: bool = False`) and are untouched by `params_builder.py` for this
// family (only `lut_mode`'s `deactivate_spatial_effects` branch forces them
// False explicitly, redundantly). `apply_diffusion_filter_um` itself
// early-returns `image` UNCHANGED when `not diffusion_filter.active`
// (`model/diffusion.py:594`) -- a TRUE identity, before it ever looks at
// `strength`/`p_s`. The runtime `radius<=0||scatterFraction<=0` guard below
// does NOT catch this: `precomputeDiffusionFilter` (`src/host/spectral.ts`)
// bakes ONE PSF per stock (radius=14, scatterFraction~0.2625,
// `family:'black_pro_mist', strength:0.5`) shared by EVERY render of that
// stock regardless of which fixture family is rendering -- it is not
// re-baked per test the way `FLAG_GLARE_ACTIVE` gates glare at the
// CoreParams level, because `diffusion.test.ts`'s own two fixtures
// (`hard_edge_diffusion_{camera,print}`/`impulse_highlight_diffusion_
// {camera,print}`) NEED that exact non-zero PSF and construct their OWN
// short stage lists directly (never touching `fullChain`/this flag,
// default `false`, unaffected). Task 16's `grain.test.ts` already proved
// camera-side omission correct empirically (cmy_film mean/var error
// unchanged at the ~1e-6/1e-3 floor with or without the stage present);
// this flag makes `fullChain`'s print-site dispatch behave identically
// (identity passthrough) while STILL closing `log10` via `kApplyFinalLog`
// -- the one duty this stage cannot skip even when inactive, since no
// other stage does it for the print site (see comment block above).
const kBypassConvolution: bool = __DIFFUSION_BYPASS_CONVOLUTION__;
const kLog10E: f32 = 0.4342944819032518;

fn resolveOutput(linear: vec3<f32>, alpha: f32) -> vec4<f32> {
  if (kApplyFinalLog) {
    return vec4<f32>(log(max(linear, vec3<f32>(0.0)) + vec3<f32>(1.0e-10)) * kLog10E, alpha);
  }
  return vec4<f32>(linear, alpha);
}

// Port of numpy's `pad(mode='reflect')` index mapping (reflect WITHOUT
// repeating the edge sample -- index -1 maps to index 1, not index 0).
// Verified against Python's actual padded+fftconvolve+crop output (not
// just against the formula) in the host-math check referenced above.
fn reflectIndex(i: i32, n: i32) -> i32 {
  if (n <= 1) {
    return 0;
  }
  let period = 2 * (n - 1);
  var m = i % period;
  if (m < 0) {
    m = m + period;
  }
  if (m < n) {
    return m;
  }
  return period - m;
}

fn samplePixel(x: i32, y: i32) -> vec4<f32> {
  let sx = reflectIndex(x, i32(params.width));
  let sy = reflectIndex(y, i32(params.height));
  return srcPixels[u32(sy) * params.width + u32(sx)];
}

@compute @workgroup_size(32, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  // Double bounds check, PERSIS pola dir.wgsl/curveDevelop.wgsl -- lih.
  // dokumentasi CoreParams di params.ts untuk kenapa keduanya wajib.
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

  let raw = srcPixels[index];

  let radius = i32(dynamicArena[__DIFFUSION_RADIUS_OFFSET__]);
  let scatterFraction = dynamicArena[__DIFFUSION_SCATTER_FRACTION_OFFSET__];

  // Port of the early-returns in `apply_diffusion_filter_um`
  // (`not diffusion_filter.active`, `strength<=0`, `p_s<=0`): the first two
  // collapse to "radius/scatterFraction baked as 0" by
  // `precomputeDiffusionFilter` (`diffusionFilter.ts`) for the fixtures that
  // actually bake a zero PSF; `kBypassConvolution` (see const above) covers
  // `not diffusion_filter.active` for stocks where the SAME shared arena
  // bakes a non-zero PSF regardless of active-state -- identity passthrough
  // either way.
  if (radius <= 0 || scatterFraction <= 0.0 || kBypassConvolution) {
    dstPixels[index] = resolveOutput(raw.rgb, raw.a);
    return;
  }

  let kernelWidth = 2 * radius + 1;
  let psfBase = __DIFFUSION_PSF_OFFSET__;
  let x0 = i32(absoluteGid.x);
  let y0 = i32(absoluteGid.y);

  var acc = vec3<f32>(0.0, 0.0, 0.0);
  for (var ky: i32 = -radius; ky <= radius; ky = ky + 1) {
    let sy = y0 + ky;
    for (var kx: i32 = -radius; kx <= radius; kx = kx + 1) {
      let sx = x0 + kx;
      let sample = samplePixel(sx, sy);
      let pIndex = psfBase + u32((ky + radius) * kernelWidth + (kx + radius)) * 3u;
      let weight = vec3<f32>(dynamicArena[pIndex], dynamicArena[pIndex + 1u], dynamicArena[pIndex + 2u]);
      acc = acc + weight * sample.rgb;
    }
  }

  // E_out = (1 - p_s) * E_in + p_s * (K_s * E_in) -- Python's convex
  // combination, `apply_diffusion_filter_um`'s final line.
  let blended = (1.0 - scatterFraction) * raw.rgb + scatterFraction * acc;
  dstPixels[index] = resolveOutput(blended, raw.a);
}
