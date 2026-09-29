/**
 * `RenderParams` -- permukaan parameter yang dilihat `Session` (dan nanti UI).
 *
 * NAMA field dan enum mengikuti `SpektraParameters.h` OFX apa adanya, supaya
 * `SpektraTooltips.h` bisa dipakai langsung sebagai teks bantuan UI (spec
 * induk §8). Hanya field yang relevan untuk Fase 2 yang didefinisikan; field
 * lain ditambah saat batch-nya dikerjakan (spec Fase 2 §4.1).
 *
 * NILAI baseline BUKAN default OFX. Baseline adalah konfigurasi yang
 * dibuktikan Fase 1: `digest_params(init_params())` Python, yaitu keluarga
 * fixture `<case>_stochastic`. Default OFX berbeda di banyak tempat
 * (`autoExposure=false`, `inputColorSpace=ArriLogC4`,
 * `outputColorSpace=Rec709Gamma24`, `grainEnabled=false`,
 * `rgbToRawMethod=Hanatos2026`, ...) dan TIDAK satu pun dari kombinasi itu
 * pernah diadu dengan Python. Padanan Python tiap field dicatat di bawah
 * (`params_schema.py` hulu, baris pada commit yang tercatat di
 * `tools/README.md`).
 *
 * Stock dirujuk dengan id string (kunci aset ter-bake), bukan indeks integer
 * OFX (`film = 2`).
 */

import type { DiffusionFilterFamily } from '../host/diffusionFilter';

export type { DiffusionFilterFamily };

/** `FilmFormat` OFX. Python hanya punya `camera.film_format_mm` (35.0 untuk `standard35`). */
export type FilmFormat =
  | 'standard8'
  | 'super8'
  | 'standard16'
  | 'super16'
  | 'standard35'
  | 'super35'
  | 'standard65'
  | 'imax70';

export interface RenderParams {
  /** Python: `film_stock` argumen `init_params`. */
  film: string;
  /** Python: `print_stock` argumen `init_params`. */
  paper: string;
  /** Python: `settings.rgb_to_raw_method` (`:222`). OFX default `Hanatos2026` -- tidak digerbangi. */
  rgbToRawMethod: 'hanatos2025';
  /** Python: `io.input_color_space` (`:170`). Label manifest. */
  inputColorSpace: string;
  /** Python: `io.input_cctf_decoding` (`:171`). Tidak ada padanan OFX (OFX selalu mendekode). */
  inputCctfDecoding: boolean;
  /** Python: `io.output_color_space` (`:172`). Label manifest. */
  outputColorSpace: string;
  /** Python: `camera.auto_exposure` (`:51`). */
  autoExposure: boolean;
  /**
   * Python: `camera.exposure_compensation_ev` (`:50`). Dengan
   * `print_exposure_compensation=True` (default Python) print di-retime
   * terhadap EV ini (midgray `0.184 * 2**ev`), jadi efeknya pada kecerahan
   * akhir kecil -- BEDA dari OFX, yang tidak mengompensasi (ruling 2C:
   * Python oracle-nya). Diabaikan `.cube` (`lut_mode`).
   */
  filmExposureEv: number;
  /** Python: `enlarger.print_exposure = 2**printExposureEv` (`:63`). Diabaikan `.cube` (`lut_mode`). */
  printExposureEv: number;
  /** Python: argumen push/pull stock (mode `Standard`). */
  filmPushPullStops: number;
  /** Python: `enlarger.c_filter_neutral` ditambah shift (`:70`). */
  filterC: number;
  /** Python: `enlarger.m_filter_shift` (`:67`). */
  filterMShift: number;
  /** Python: `enlarger.y_filter_shift` (`:66`). */
  filterYShift: number;
  /** Python: `film_render.halation.active` (`:105`). */
  halationEnabled: boolean;
  /** Python: `film_render.halation.halation_amount` (`:109`). */
  halationAmount: number;
  /** Python: `film_render.grain.active` (`:90`). */
  grainEnabled: boolean;
  /** OFX `grainAmount`; padanan Python ditetapkan di batch parameter 1. */
  grainAmount: number;
  /** OFX `grainSeed`. Python memakai seed acak; digerbangi secara statistik (Gate B). */
  grainSeed: number;
  /** Python: `camera.film_format_mm` (`:54`). */
  filmFormat: FilmFormat;
  /** Python: `camera.diffusion_filter.active` (`:16`/`:57`). */
  cameraDiffusionEnabled: boolean;
  /** Python: `camera.diffusion_filter.filter_family` (`:19`). */
  cameraDiffusionFamily: DiffusionFilterFamily;
  /** Python: `camera.diffusion_filter.strength` (`:21`). */
  cameraDiffusionStrength: number;
  /** Python: `enlarger.diffusion_filter.active` (`:72`). */
  printDiffusionEnabled: boolean;
  /** Python: `enlarger.diffusion_filter.filter_family`. */
  printDiffusionFamily: DiffusionFilterFamily;
  /** Python: `enlarger.diffusion_filter.strength`. */
  printDiffusionStrength: number;
  /** Python: `print_render.glare.active` (`:145`/`:162`). Tidak ada padanan OFX terpisah. */
  glareEnabled: boolean;
  /** Python: `print_render.glare.percent` (`:146`). */
  glarePercent: number;
  /** Python: `scanner.unsharp_mask[1]` (amount, `:85`). */
  scannerUnsharpAmount: number;
  /** Python: `film_render.dir_couplers.active` (`:131`). OFX: `dirCouplersAmount > 0`. */
  dirCouplersEnabled: boolean;
  /** Python: `film_render.dir_couplers.amount` (`:132`). OFX default 0 -- Python 1 (oracle). */
  dirCouplersAmount: number;
  /** Python: `film_render.dir_couplers.inhibition_samelayer` (`:133`). */
  dirCouplersInhibitionSameLayer: number;
  /** Python: `film_render.dir_couplers.inhibition_interlayer` (`:134`). */
  dirCouplersInhibitionInterlayer: number;
  /** Python: `film_render.dir_couplers.diffusion_size_um` (`:139`); 0 mematikan difusi (dan ekornya). */
  dirCouplersDiffusionUm: number;
}

export const BASELINE_RENDER_PARAMS: Readonly<RenderParams> = Object.freeze({
  film: 'kodak_portra_400',
  paper: 'kodak_portra_endura',
  rgbToRawMethod: 'hanatos2025',
  inputColorSpace: 'ProPhoto RGB',
  inputCctfDecoding: false,
  outputColorSpace: 'sRGB',
  autoExposure: true,
  filmExposureEv: 0,
  printExposureEv: 0,
  filmPushPullStops: 0,
  filterC: 0,
  filterMShift: 0,
  filterYShift: 0,
  halationEnabled: true,
  halationAmount: 1,
  grainEnabled: true,
  grainAmount: 1,
  grainSeed: 1,
  filmFormat: 'standard35',
  cameraDiffusionEnabled: false,
  cameraDiffusionFamily: 'black_pro_mist',
  cameraDiffusionStrength: 0.5,
  printDiffusionEnabled: false,
  printDiffusionFamily: 'black_pro_mist',
  printDiffusionStrength: 0.5,
  glareEnabled: true,
  glarePercent: 0.03,
  scannerUnsharpAmount: 0.7,
  dirCouplersEnabled: true,
  dirCouplersAmount: 1,
  dirCouplersInhibitionSameLayer: 1,
  dirCouplersInhibitionInterlayer: 1,
  dirCouplersDiffusionUm: 20,
});
