/**
 * `buildRenderPlan` -- SATU-SATUNYA tempat `RenderParams` diterjemahkan ke
 * bahasa engine (spec Fase 2 §4.2). Menggantikan `defaultCoreParams` di
 * `test/parity/params.ts` (Fase 1), yang isinya dipindah ke sini apa adanya
 * dan dibuktikan setara field per field oleh `test/plan.test.ts` sebelum yang
 * lama dihapus.
 *
 * Dua mode:
 *
 * - `'image'` -- keluarga fixture `measured`. Auto-exposure diukur dari isi
 *   gambar (`measureAutoExposureEv`, dihitung host sebelum dispatch, persis
 *   `SpektraVulkanRenderer.cpp::measureAutoExposureEv`). `slot0 = 1`: film
 *   exposure menyimpan cabang LINEAR, halation yang menutup `log10`.
 * - `'cube'` -- keluarga fixture `_lut` (`debug.lut_mode=True`): auto-exposure,
 *   efek spasial, dan efek stokastik mati. Kubus tidak boleh bergantung pada
 *   isi gambar dan secara prinsip tidak bisa membawa efek spasial (spec induk
 *   §7.2), dan itu PERSIS semantik `lut_mode` -- jadi `.cube` memakai jalur
 *   yang sudah digerbangi sampai `rgb_out` di Fase 1, bukan jalur kedua.
 *   `slot0 = 0`: film/print exposure menutup `log10` sendiri.
 */

import { FLAG_GLARE_ACTIVE, FLAG_UNSHARP_ACTIVE } from '../engine/params';
import type { CoreParams } from '../engine/params';
import { estimateTileOverlap } from '../engine/tiling';
import { measureAutoExposureEv } from '../host/autoExposure';
import type { EnlargerFilterState } from '../host/enlarger';
import type { PrintScanArenaOptions } from '../host/spectral';
import type { AssetBundle } from '../profiles/load';
import { validateRenderParams } from './registry';
import type { RenderParams } from './renderParams';

export type RenderMode = 'image' | 'cube';

export interface ChainSpec {
  family: 'measured' | 'lut';
  /** Tahap grain disertakan. Selalu `false` untuk `lut`. */
  grain: boolean;
}

export interface ArenaInputs {
  stockId: string;
  printScan: PrintScanArenaOptions;
}

export interface RenderPlan {
  core: CoreParams;
  /** Kunci cache arena: semua masukan `precomputeArenaData` yang bisa berubah. */
  arenaKey: string;
  arenaInputs: ArenaInputs;
  chain: ChainSpec;
  /** Apron tiling (px) dari `estimateTileOverlap`; 0 untuk `cube`. */
  overlap: number;
  /** Efek yang dimatikan mode ini -- ditulis ke header `.cube` (spec induk §7.2). */
  disabledEffects: string[];
}

export interface PlanImage {
  width: number;
  height: number;
  rgba: Float32Array;
}

const CUBE_DISABLED_EFFECTS = [
  'halation',
  'grain',
  'camera diffusion',
  'print diffusion',
  'DIR diffusion',
  'glare',
  'unsharp mask',
  'auto exposure',
];

/**
 * Filter netral enlarger (Kodak CC) hanya ter-bake untuk SATU triple
 * (film, print, illuminant) -- `manifest.printScan`, hasil
 * `apply_database_neutral_print_filters()` Python (lih.
 * `tools/bake_web_assets.py::_default_enlarger_neutral_filters`). Memakai
 * nilai triple itu untuk pasangan lain akan memberi keseimbangan warna
 * yang salah tanpa galat apa pun, jadi pasangan lain ditolak keras.
 */
export class MissingNeutralFiltersError extends Error {
  constructor(film: string, paper: string) {
    super(
      `Filter netral enlarger untuk pasangan film "${film}" / paper "${paper}" belum ter-bake ` +
        '(hanya pasangan di manifest.printScan yang tersedia).',
    );
    this.name = 'MissingNeutralFiltersError';
  }
}

export function resolveEnlargerFilters(
  bundle: AssetBundle,
  film: string,
  paper: string,
  mShift: number,
  yShift: number,
): EnlargerFilterState {
  const baked = bundle.manifest.printScan;
  if (film !== baked.filmStock || paper !== baked.printStock) {
    throw new MissingNeutralFiltersError(film, paper);
  }
  return {
    cFilterNeutral: baked.neutralFilterC,
    mFilterNeutral: baked.neutralFilterM,
    mFilterShift: mShift,
    yFilterNeutral: baked.neutralFilterY,
    yFilterShift: yShift,
  };
}

export function buildRenderPlan(
  params: RenderParams,
  bundle: AssetBundle,
  image: PlanImage,
  mode: RenderMode,
): RenderPlan {
  validateRenderParams(params);

  const family = mode === 'cube' ? 'lut' : 'measured';
  // `grainEnabled === glareEnabled` dijamin validateRenderParams; keduanya
  // mati di lut_mode.
  const stochasticEffectsActive = family === 'measured' && params.grainEnabled;

  const enlargerFilters = resolveEnlargerFilters(
    bundle,
    params.film,
    params.paper,
    params.filterMShift,
    params.filterYShift,
  );

  const overlap =
    family === 'lut'
      ? 0
      : estimateTileOverlap({
          halationEnabled: params.halationEnabled,
          grainEnabled: params.grainEnabled,
          // Kedua situs diffusion berjalan sebagai identitas spasial
          // (`bypassConvolution`, lih. `src/engine/chain.ts`) selama
          // `*DiffusionEnabled` locked ke false.
          cameraDiffusionEnabled: params.cameraDiffusionEnabled,
          printDiffusionEnabled: params.printDiffusionEnabled,
          // DIR coupler aktif (amount 1, difusi spasial 20 um) di keluarga measured.
          dirCouplersAmount: 1,
          scannerUnsharpEnabled: params.scannerUnsharpAmount > 0,
        });

  return {
    core: buildCoreParams(params, bundle, image, family, stochasticEffectsActive),
    arenaKey: `${params.film}::print=${params.paper}::m=${params.filterMShift}::y=${params.filterYShift}`,
    arenaInputs: {
      stockId: params.film,
      printScan: { printStockId: params.paper, enlargerFilters },
    },
    chain: { family, grain: stochasticEffectsActive },
    overlap,
    disabledEffects: family === 'lut' ? [...CUBE_DISABLED_EFFECTS] : [],
  };
}

/**
 * Isi `defaultCoreParams` Fase 1 (Task 11-18c). Sejarah tiap keputusan ada di
 * laporan task yang dirujuk; ringkasnya:
 *
 * - `filmExposureEv` MENCAKUP hasil auto-exposure yang bergantung isi gambar
 *   (`camera.auto_exposure` default `True`), dibuktikan lewat rasio
 *   `rgb_pre/input` yang konstan per gambar tapi berbeda antar gambar
 *   (task-11-report.md). `lut_mode` mematikannya.
 * - Glare hanya menyala saat `measured` DAN efek stokastik hidup
 *   (`deactivate_stochastic_effects` mematikan `print_render.glare.active`);
 *   unsharp menyala untuk `measured` terlepas dari efek stokastik (hanya
 *   `deactivate_spatial_effects`/`lut_mode` yang menolkannya) -- Task 18c,
 *   dibuktikan `measuredChain.test.ts`.
 * - `slot0`: `lut` menyimpan cabang LOG langsung (film exposure menutup
 *   `log10` sendiri); `measured` menyimpan LINEAR (halation yang menutupnya).
 */
/**
 * Sumber tiap field (dipindah dari `test/parity/params.ts`, Fase 1 Task 11;
 * keterangan `slot0` di bawah mendahului Task 14 -- keluarga `measured`
 * sekarang memakai cabang LINEAR, lih. ringkasan di atas):
 * `CoreParams` yang mencerminkan `digest_params(init_params())` Python
 * untuk stock `kodak_portra_400` (default `gen_reference.py`/`init_params`)
 * pada tahap FilmExposure. Field yang TIDAK dibaca `filmExposure.wgsl`
 * (`filmGamma`, `filmPushPullMode/Stops`, tiling) diberi nilai netral
 * (tidak berpengaruh, dicatat sebagai demikian) -- bukan ditebak dari nama.
 *
 * Field demi field, dengan sumber:
 *   - `width`/`height`/`fullWidth`/`fullHeight` — dimensi kasus uji (tidak
 *     di-tile, jadi keduanya sama; lih. `params.ts::CoreParams` untuk tiga
 *     ruang koordinat).
 *   - `filmExposureEv` — `camera.exposure_compensation_ev` (0.0, default
 *     `CameraParams`) + `measureAutoExposureEv(...)` (lih. di atas) --
 *     KEDUANYA linear dalam skala raw (`hanatosRaw`/`mallettRaw` linear
 *     terhadap magnitudo input, lih. task-11-report.md), jadi menjumlahkan
 *     keduanya di ruang EV/log2 SETARA dengan menerapkan auto-exposure
 *     sebagai perkalian rgb SEBELUM konversi (yang dilakukan Python) --
 *     dibuktikan, bukan diasumsikan.
 *   - `inputColorSpace` — indeks "ProPhoto RGB" pada
 *     `manifest.colorSpaces.labels` (`io.input_color_space` default).
 *   - `rgbToRawMethod` — 0 (hanatos2025, `settings.rgb_to_raw_method`
 *     default) -- shader memilih mallett hanya bila `== 1`.
 *   - `colorSpaceCount`/`transferLutSize`/`colorDecodeMin`/`colorDecodeMax`
 *     — dari `manifest.colorSpaces` (Task 4), bukan dihardcode ulang.
 *   - `hanatosWidth`/`hanatosHeight` — dari `manifest.hanatos` (Task 4).
 *   - `slot0` — 0: pilih cabang LOG (`_pad0==1u` adalah cabang linear;
 *     tap `log_e_film` butuh log).
 *   - `slot1` — `FLAG_COLOR_ADAPTATION_INPUT_COMPRESSION` (bit 0): Python
 *     `InputGamutCompressSpec.active` default `True`
 *     (`gamut_compression.py:69`), TIDAK dimatikan `digest_params` untuk
 *     konfigurasi ini -- shader harus membaca separuh TERKOMPRESI
 *     `HanatosRawResponse`. Task 18 Gate B menambahkan bit 2
 *     (`FLAG_GLARE_ACTIVE`, `scannerPost.wgsl`-only): menyala untuk
 *     `family: 'measured'`, padam untuk `'lut'` -- lih. `FLAG_GLARE_ACTIVE`
 *     (`src/engine/params.ts`) untuk alasan lengkap.
 *   - `slot2` — 0. `filmExposure.wgsl` tidak lagi membaca field ini
 *     (review seluruh-branch agenda #5 -- cabang "buffer tetangga
 *     resolusi-penuh" yang dulu di sini dihapus sebagai kode mati
 *     berbahaya, bukan diaktifkan oleh tiling Task 19).
 *   - `activeOrigin*`/`tileOrigin*` — 0; `activeWidth/Height` — 0 (berarti
 *     "seluruh buffer", lih. `params.ts`).
 */
function buildCoreParams(
  params: RenderParams,
  bundle: AssetBundle,
  image: PlanImage,
  family: 'measured' | 'lut',
  stochasticEffectsActive: boolean,
): CoreParams {
  const { width, height } = image;
  const { colorSpaces } = bundle.manifest;
  const inputColorSpace = colorSpaces.labels.indexOf(params.inputColorSpace);
  if (inputColorSpace < 0) {
    throw new Error(`"${params.inputColorSpace}" tidak ditemukan di manifest.colorSpaces.labels`);
  }

  let filmExposureEv = params.filmExposureEv;
  if (family === 'measured' && params.autoExposure) {
    filmExposureEv += measureAutoExposureEv(
      image.rgba,
      width,
      height,
      bundle.staticTable('inputMeterXyzMatrices'),
      inputColorSpace,
    );
  }

  const FLAG_COLOR_ADAPTATION_INPUT_COMPRESSION = 1 << 0;
  const glareActiveFlag = family === 'measured' && stochasticEffectsActive ? FLAG_GLARE_ACTIVE : 0;
  const unsharpActiveFlag = family === 'measured' ? FLAG_UNSHARP_ACTIVE : 0;

  return {
    width,
    height,
    filmExposureEv,
    filmGamma: 1, // density_curve_gamma default Python (FilmRenderingParams)
    // curveDevelop.wgsl membaca ini sebagai batas pencarian biner kurva H&D.
    exposureCount: bundle.stock(params.film).entry.exposureCount,
    inputColorSpace,
    rgbToRawMethod: 0, // hanatos2025
    colorSpaceCount: colorSpaces.count,
    transferLutSize: colorSpaces.transferLutSize,
    colorDecodeMin: colorSpaces.decodeLutMin,
    colorDecodeMax: colorSpaces.decodeLutMax,
    hanatosWidth: bundle.manifest.hanatos.width,
    hanatosHeight: bundle.manifest.hanatos.height,
    slot0: family === 'lut' ? 0 : 1,
    slot1: FLAG_COLOR_ADAPTATION_INPUT_COMPRESSION | glareActiveFlag | unsharpActiveFlag,
    // Tidak lagi dibaca filmExposure.wgsl (review seluruh-branch Fase 1, agenda #5).
    slot2: 0,
    // Push/pull tidak aktif; curveDevelop.wgsl membaca mode ini.
    filmPushPullMode: 0,
    filmPushPullStops: params.filmPushPullStops,
    fullWidth: width,
    fullHeight: height,
    tileOriginX: 0,
    tileOriginY: 0,
    activeOriginX: 0,
    activeOriginY: 0,
    activeWidth: 0, // 0 = seluruh buffer
    activeHeight: 0,
  };
}
