/**
 * Task 15 (resumed after BLOCKED): host-side reproduction of
 * `$SPEKTRAFILM_PY/src/spektrafilm/model/diffusion.py::diffusion_filter_psf`
 * + `_strength_to_scatter` + the kernel-radius arithmetic from
 * `apply_diffusion_filter_um`, EXACT (not the OFX pyramid approximation --
 * see the correction block at Global Constraints / Task 15 in
 * `docs/superpowers/plans/2026-09-11-dichroic-phase1-engine.md`, and
 * `task-15-report.md` for the measurement that killed the pyramid path).
 *
 * `apply_diffusion_filter_um` itself does
 *   `scipy.signal.fftconvolve(reflect-padded, psf, mode='same')`
 * which is mathematically IDENTICAL to a direct spatial convolution against
 * the same finite kernel (fftconvolve is an FFT-accelerated exact
 * convolution, not an approximation) -- verified equal to Python's actual
 * output at ~1e-14/1e-15 (f64 machine-precision noise) by a host-math JS
 * reimplementation run BEFORE any WGSL was written (Task 12-14 method),
 * against `apply_diffusion_filter_um` imported directly from the Python
 * module. See task-15-report.md for the probe scripts and numbers.
 *
 * This module does the CPU-heavy part (building the PSF, which involves
 * O(kernelPixels * componentsPerGroup) exp() calls -- up to 29*29*3*~9 ~=
 * 22700 for the family/strength this task's new fixture uses) --
 * `precomputeArenaData()` calls it, which per the Global Constraints note
 * ("Kerja CPU berat WAJIB selesai sebelum acquireDevice()") MUST run
 * before any `GPUDevice` exists in the process. `diffusion.wgsl` only does
 * the O(kernelPixels) per-pixel convolution on GPU; it never rebuilds the
 * kernel itself.
 *
 * CAVEAT, DECLARED NOT HIDDEN: the PSF baked here is only valid for the
 * specific `pixelSizeUm` passed in (kernel radius/shape scale with it,
 * exactly like Python's `apply_diffusion_filter_um`). Unlike
 * `halationStrength`/`dirCouplersMatrix` (genuinely per-STOCK constants,
 * safe to cache once per `stockId` across fixtures of any size --
 * `halation.ts` instead computes its `pixelSizeUm`-dependent scalar fresh
 * at `encode()` time for exactly this reason), the diffusion PSF is
 * per-FIXTURE-SIZE. `precomputeArenaData()` bakes ONE PSF (for the 64px/
 * 35mm fixture size this task's two new cases use, `CAMERA_PIXEL_SIZE_UM`
 * in `spectral.ts`) into the `dynamic` arena, which is cached per `stockId`
 * across the whole test process (`test/parity/run.ts::sharedResources`).
 * A future task adding a diffusion fixture at a DIFFERENT image size on
 * the same stock would get a wrong (stale-size) kernel from this cache --
 * it would need to extend `precomputeArenaData`'s signature to accept
 * pixel size, not silently reuse this one. Recomputing per-encode() (like
 * halation's scalar) is NOT safe here: unlike a single float division,
 * building a `(2r+1)x(2r+1)x3` kernel is real host CPU float work, and the
 * Global Constraints note is explicit that such work after `acquireDevice()`
 * segfaults Node deterministically at the next queue sync -- this is
 * exactly the kind of computation the note calls out by name.
 */

export type DiffusionFilterFamily = 'glimmerglass' | 'black_pro_mist' | 'pro_mist' | 'cinebloom';

interface GroupConfig {
  lambdaUm: number;
  spread: number;
  nComponents: number;
  alpha?: number;
}

interface FamilyConfig {
  core: GroupConfig;
  halo: GroupConfig;
  bloom: GroupConfig;
  wCore: number;
  wHalo: number;
  wBloom: number;
  haloWarmthBase: number;
}

/** Port `_DIFFUSION_FILTER_SHAPES` (`model/diffusion.py:185-242`), verbatim numbers. */
const FAMILIES: Record<DiffusionFilterFamily, FamilyConfig> = {
  glimmerglass: {
    core: { lambdaUm: 10.0, spread: 1.5, nComponents: 2 },
    halo: { lambdaUm: 50.0, spread: 2.0, nComponents: 3 },
    bloom: { lambdaUm: 260.0, spread: 2.5, nComponents: 4, alpha: 3.2 },
    wCore: 0.6, wHalo: 0.3, wBloom: 0.1,
    haloWarmthBase: 0.0,
  },
  black_pro_mist: {
    core: { lambdaUm: 16.0, spread: 1.5, nComponents: 2 },
    halo: { lambdaUm: 95.0, spread: 2.0, nComponents: 3 },
    bloom: { lambdaUm: 380.0, spread: 2.5, nComponents: 4, alpha: 3.5 },
    wCore: 0.4, wHalo: 0.47, wBloom: 0.13,
    haloWarmthBase: 0.65,
  },
  pro_mist: {
    core: { lambdaUm: 14.0, spread: 1.5, nComponents: 2 },
    halo: { lambdaUm: 150.0, spread: 2.0, nComponents: 3 },
    bloom: { lambdaUm: 650.0, spread: 2.5, nComponents: 4, alpha: 2.9 },
    wCore: 0.28, wHalo: 0.42, wBloom: 0.3,
    haloWarmthBase: 0.4,
  },
  cinebloom: {
    core: { lambdaUm: 20.0, spread: 1.5, nComponents: 2 },
    halo: { lambdaUm: 200.0, spread: 2.0, nComponents: 3 },
    bloom: { lambdaUm: 1000.0, spread: 2.5, nComponents: 4, alpha: 2.5 },
    wCore: 0.22, wHalo: 0.3, wBloom: 0.48,
    haloWarmthBase: 0.85,
  },
};

/** Port `_DIFFUSION_FAMILY_TOTAL_GAIN` (:253-258). */
const FAMILY_TOTAL_GAIN: Record<DiffusionFilterFamily, number> = {
  glimmerglass: 0.65,
  black_pro_mist: 0.75,
  pro_mist: 1.05,
  cinebloom: 1.0,
};

/** Port `_DIFFUSION_STRENGTH_BREAKPOINTS`/`_TOTAL_FRACTION` (:267-268). */
const STRENGTH_BREAKPOINTS = [0.125, 0.25, 0.5, 1.0, 2.0];
const STRENGTH_TOTAL_FRACTION = [0.1, 0.2, 0.35, 0.55, 0.75];

/**
 * Port `_strength_to_scatter` (:271-288) -- `np.interp` in log2(strength)
 * space, piecewise-linear, clamped at both ends (matches `np.interp`'s own
 * clamp-to-endpoint behaviour, NOT extrapolation).
 */
export function strengthToScatter(strength: number, family: DiffusionFilterFamily): number {
  if (strength <= 0) return 0;
  const logStrength = Math.log2(Math.max(strength, 1e-6));
  const logBreaks = STRENGTH_BREAKPOINTS.map((v) => Math.log2(v));
  let baseTotal: number;
  if (logStrength <= logBreaks[0]!) {
    baseTotal = STRENGTH_TOTAL_FRACTION[0]!;
  } else if (logStrength >= logBreaks[logBreaks.length - 1]!) {
    baseTotal = STRENGTH_TOTAL_FRACTION[STRENGTH_TOTAL_FRACTION.length - 1]!;
  } else {
    let lo = 0;
    while (logBreaks[lo + 1]! <= logStrength) lo += 1;
    const t = (logStrength - logBreaks[lo]!) / (logBreaks[lo + 1]! - logBreaks[lo]!);
    baseTotal = STRENGTH_TOTAL_FRACTION[lo]! + t * (STRENGTH_TOTAL_FRACTION[lo + 1]! - STRENGTH_TOTAL_FRACTION[lo]!);
  }
  const gain = FAMILY_TOTAL_GAIN[family] ?? 1.0;
  return Math.min(Math.max(baseTotal * gain, 0), 0.99);
}

/** Per-group multipliers -- port `_overrides_from_params`/`_resolve_family_cfg` (:383-448). All default 1.0. */
export interface DiffusionFilterOverrides {
  coreIntensity?: number;
  haloIntensity?: number;
  bloomIntensity?: number;
  coreSize?: number;
  haloSize?: number;
  bloomSize?: number;
}

function resolveFamilyCfg(family: DiffusionFilterFamily, overrides?: DiffusionFilterOverrides): FamilyConfig {
  const base = FAMILIES[family];
  if (!overrides) return base;
  const ci = overrides.coreIntensity ?? 1.0;
  const hi = overrides.haloIntensity ?? 1.0;
  const bi = overrides.bloomIntensity ?? 1.0;
  const cs = overrides.coreSize ?? 1.0;
  const hs = overrides.haloSize ?? 1.0;
  const bs = overrides.bloomSize ?? 1.0;
  if (ci === 1 && hi === 1 && bi === 1 && cs === 1 && hs === 1 && bs === 1) return base;
  const wCore = base.wCore * Math.max(ci, 0);
  const wHalo = base.wHalo * Math.max(hi, 0);
  const wBloom = base.wBloom * Math.max(bi, 0);
  const total = wCore + wHalo + wBloom;
  if (total <= 0) return base;
  return {
    core: { ...base.core, lambdaUm: base.core.lambdaUm * Math.max(cs, 1e-6) },
    halo: { ...base.halo, lambdaUm: base.halo.lambdaUm * Math.max(hs, 1e-6) },
    bloom: { ...base.bloom, lambdaUm: base.bloom.lambdaUm * Math.max(bs, 1e-6) },
    wCore: wCore / total,
    wHalo: wHalo / total,
    wBloom: wBloom / total,
    haloWarmthBase: base.haloWarmthBase,
  };
}

function bloomMaxLambdaUm(family: DiffusionFilterFamily, overrides?: DiffusionFilterOverrides): number {
  const cfg = resolveFamilyCfg(family, overrides);
  return cfg.bloom.lambdaUm * cfg.bloom.spread;
}

/** Port `_expand_group` (:291-318): geometric progression of sub-component lambdas + weights. */
function expandGroup(group: GroupConfig, kind: 'core' | 'halo' | 'bloom'): { lambdas: number[]; weights: number[] } {
  const { lambdaUm, spread, nComponents } = group;
  const n = Math.max(nComponents, 1);
  if (n === 1 || spread <= 1.0) return { lambdas: [lambdaUm], weights: [1.0] };

  const logLo = Math.log(lambdaUm / spread);
  const logHi = Math.log(lambdaUm * spread);
  const lambdas: number[] = [];
  for (let i = 0; i < n; i += 1) lambdas.push(Math.exp(logLo + (i * (logHi - logLo)) / (n - 1)));

  let weights: number[];
  if (kind === 'bloom') {
    const alpha = group.alpha ?? 3.0;
    weights = lambdas.map((l) => l ** (2.0 - alpha));
  } else {
    weights = lambdas.map(() => 1.0);
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  return { lambdas, weights: weights.map((w) => w / sum) };
}

/** Port `_HALO_CHANNEL_WARMTH_AXIS` (:332). */
const HALO_CHANNEL_WARMTH_AXIS = [1.3, 0.15, -1.45];

/**
 * Port `_halo_channel_weights` (:335-380): energy-conserving per-channel
 * redistribution of halo sub-component weights along the warmth axis.
 * Returns [R, G, B] arrays of length `weights.length`.
 */
function haloChannelWeights(weights: number[], warmth: number): [number[], number[], number[]] {
  const n = weights.length;
  if (n < 2) return [weights.slice(), weights.slice(), weights.slice()];
  const clampedWarmth = Math.min(Math.max(warmth, -1.5), 1.5);
  const g: number[] = [];
  for (let i = 0; i < n; i += 1) g.push(-1.0 + (2.0 * i) / (n - 1));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const gAvg = g.reduce((acc, gv, i) => acc + gv * weights[i]!, 0) / weightSum;
  const gCentered = g.map((gv) => gv - gAvg);
  const targetTotal = weightSum;

  const out: [number[], number[], number[]] = [[], [], []];
  for (let c = 0; c < 3; c += 1) {
    const axis = HALO_CHANNEL_WARMTH_AXIS[c]!;
    let raw = weights.map((w, k) => w * (1.0 + clampedWarmth * axis * gCentered[k]!));
    raw = raw.map((v) => Math.max(v, 0.0));
    const s = raw.reduce((a, b) => a + b, 0);
    out[c] = s > 0 ? raw.map((v) => (v * targetTotal) / s) : weights.slice();
  }
  return out;
}

function expSum(r: Float64Array, lambdasPx: number[], weights: number[]): Float64Array {
  const out = new Float64Array(r.length);
  for (let k = 0; k < lambdasPx.length; k += 1) {
    const lk = Math.max(lambdasPx[k]!, 1e-6);
    const wk = weights[k]!;
    const denom = 2.0 * Math.PI * lk * lk;
    for (let i = 0; i < r.length; i += 1) out[i]! += (wk * Math.exp(-r[i]! / lk)) / denom;
  }
  return out;
}

/**
 * Port `diffusion_filter_psf` (:542-582): per-channel 2D PSF, shape
 * `(size, size, 3)`, C-order `(y*size+x)*3+channel`, sum-normalised per
 * channel on the grid -- exactly like the Python return value. `size` MUST
 * be odd (`2*radius+1`, matching `apply_diffusion_filter_um`'s own
 * `psf_shape`).
 */
export function diffusionFilterPsf(
  size: number,
  family: DiffusionFilterFamily,
  pixelSizeUm: number,
  spatialScale: number,
  haloWarmth: number,
  overrides?: DiffusionFilterOverrides,
): Float64Array {
  const cfg = resolveFamilyCfg(family, overrides);
  const effectiveWarmth = cfg.haloWarmthBase + haloWarmth;
  const scale = Math.max(spatialScale, 1e-6);

  const core = expandGroup(cfg.core, 'core');
  const halo = expandGroup(cfg.halo, 'halo');
  const bloom = expandGroup(cfg.bloom, 'bloom');
  const haloPerChannel = haloChannelWeights(halo.weights, effectiveWarmth);

  const coreLambdasPx = core.lambdas.map((l) => (l * scale) / pixelSizeUm);
  const haloLambdasPx = halo.lambdas.map((l) => (l * scale) / pixelSizeUm);
  const bloomLambdasPx = bloom.lambdas.map((l) => (l * scale) / pixelSizeUm);

  const cy = Math.floor(size / 2);
  const cx = Math.floor(size / 2);
  const r = new Float64Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dy = y - cy;
      const dx = x - cx;
      r[y * size + x] = Math.sqrt(dx * dx + dy * dy);
    }
  }

  const coreVal = expSum(r, coreLambdasPx, core.weights);
  const bloomVal = expSum(r, bloomLambdasPx, bloom.weights);
  const haloVal = [0, 1, 2].map((c) => expSum(r, haloLambdasPx, haloPerChannel[c]!));

  const psf = new Float64Array(size * size * 3);
  for (let c = 0; c < 3; c += 1) {
    let sum = 0;
    for (let i = 0; i < size * size; i += 1) {
      const v = cfg.wCore * coreVal[i]! + cfg.wHalo * haloVal[c]![i]! + cfg.wBloom * bloomVal[i]!;
      psf[i * 3 + c] = v;
      sum += v;
    }
    for (let i = 0; i < size * size; i += 1) psf[i * 3 + c]! /= sum;
  }
  return psf;
}

export interface DiffusionFilterConfig {
  family: DiffusionFilterFamily;
  strength: number;
  spatialScale?: number;
  haloWarmth?: number;
  overrides?: DiffusionFilterOverrides;
}

export interface PrecomputedDiffusionFilter {
  radius: number;
  /** `p_s`, the energy-conserving deflected-photon fraction. */
  scatterFraction: number;
  /** Shape `(2*radius+1, 2*radius+1, 3)`, C-order, f32 for GPU upload. */
  psf: Float32Array;
  /** Nilai f64 yang sama (Fase 2D: dipecah ke df64 untuk konvolusi FFT). */
  psf64: Float64Array;
}

/**
 * Port the radius/PSF-build half of `apply_diffusion_filter_um`
 * (:585-639), MINUS the convolution itself (that's `diffusion.wgsl`'s
 * job). `minImageDim` is `min(image.shape[:2])` in Python -- the smaller
 * of width/height of the image this filter will run on, used only to cap
 * the radius so it can never exceed the image.
 */
/**
 * Radius kernel `apply_diffusion_filter_um` tanpa membangun PSF: 0 bila
 * filter tidak berefek (strength/p_s/spatial scale <= 0), selain itu
 * `min(ceil(max(8 * lambda_max_px, 5)), max(min_dim // 2 - 1, 1))`.
 */
export function diffusionRadius(config: DiffusionFilterConfig, pixelSizeUm: number, minImageDim: number): number {
  const spatialScale = config.spatialScale ?? 1.0;
  if (!(config.strength > 0) || !(spatialScale > 0)) return 0;
  if (strengthToScatter(config.strength, config.family) <= 0) return 0;
  const bloomMaxLambdaPx = (bloomMaxLambdaUm(config.family, config.overrides) * spatialScale) / pixelSizeUm;
  const radius = Math.ceil(Math.max(8.0 * bloomMaxLambdaPx, 5.0));
  return Math.min(radius, Math.max(Math.floor(minImageDim / 2) - 1, 1));
}

export function precomputeDiffusionFilter(
  config: DiffusionFilterConfig,
  pixelSizeUm: number,
  minImageDim: number,
): PrecomputedDiffusionFilter {
  const spatialScale = config.spatialScale ?? 1.0;
  const haloWarmth = config.haloWarmth ?? 0.0;

  if (!(config.strength > 0) || !(spatialScale > 0)) {
    return { radius: 0, scatterFraction: 0, psf: new Float32Array([1, 1, 1]), psf64: new Float64Array([1, 1, 1]) };
  }

  const scatterFraction = strengthToScatter(config.strength, config.family);
  if (scatterFraction <= 0) {
    return { radius: 0, scatterFraction: 0, psf: new Float32Array([1, 1, 1]), psf64: new Float64Array([1, 1, 1]) };
  }

  const bloomMaxLambdaPx = (bloomMaxLambdaUm(config.family, config.overrides) * spatialScale) / pixelSizeUm;
  let radius = Math.ceil(Math.max(8.0 * bloomMaxLambdaPx, 5.0));
  radius = Math.min(radius, Math.max(Math.floor(minImageDim / 2) - 1, 1));

  const size = 2 * radius + 1;
  const psf64 = diffusionFilterPsf(size, config.family, pixelSizeUm, spatialScale, haloWarmth, config.overrides);
  return { radius, scatterFraction, psf: Float32Array.from(psf64), psf64 };
}
