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

/**
 * `ProcessMode` OFX. `printSimulation`: negatif dicetak ke kertas lalu
 * di-scan (topologi default Python). `scanNegative`: film di-scan langsung
 * (`io.scan_film=True`) -- untuk film reversal hasilnya positif (slide),
 * untuk film negatif hasilnya negatif oranye. `ProcessNegative` OFX tidak
 * punya padanan Python dan tidak dibuka.
 */
export type ProcessMode = 'printSimulation' | 'scanNegative';

export interface RenderParams {
  /** OFX `process`; Python `io.scan_film` (Fase 2D Task 3). */
  process: ProcessMode;
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
  /** Python: `enlarger.preflash_exposure` (`:81`). OFX 0..1. */
  preflashExposure: number;
  /** Python: `enlarger.preflash_m_filter_shift` (`:83`), Kodak CC. */
  preflashMFilterShift: number;
  /** Python: `enlarger.preflash_y_filter_shift` (`:82`), Kodak CC. */
  preflashYFilterShift: number;

  // --- Ekstensi DICHROIC (status `extension`, TANPA padanan Python) --------
  // "Camera Raw" (`host/cameraDevelop.ts`): develop kamera sebelum film.
  // Nilai baseline netral = tahap dilewati persis.
  /** Suhu iluminan adegan, K (2000..12000). 5500 = identitas. */
  cameraWhiteBalanceK: number;
  cameraExposureEv: number;
  /** Tint iluminan, -1..1 (Duv ±0.02; + = cahaya hijau). */
  cameraTint: number;
  /** Kemiringan log2 di sekitar pivot, -0.75..0.75 (pengali 2^x). */
  cameraContrast: number;
  /** Stop di pusat masker terang (+1.5 stop), -1.5..1.5. */
  cameraHighlights: number;
  /** Stop di pusat masker gelap (-1.5 stop), -1.5..1.5. */
  cameraShadows: number;
  /** Stop di ujung putih (+4 stop), -2..2. */
  cameraWhites: number;
  /** Stop di ujung hitam (-4 stop), -2..2. */
  cameraBlacks: number;
  /** Saturasi di sekitar luminans, 0..2. */
  cameraSaturation: number;
  /** Isolated HSV S gain in linear input RGB, 0..2; 1 is identity. */
  cameraHsvSaturation: number;
  /** Input detail attenuation, 0..1; zero bypasses the spatial stage. */
  cameraSoftenDetail: number;

  // Lens blur (`host/lens.ts`, `stages/lensBlur.ts`): defocus sintetis dari
  // peta kedalaman Depth Anything V2 yang diestimasi di perangkat. Tanpa peta
  // kedalaman (`Session.setDepthMap`) tahap ini tidak ada, apa pun nilainya.
  /** Sakelar lens blur. */
  lensBlurEnabled: boolean;
  /** Titik fokus, 0..1 dari kiri. */
  lensFocusX: number;
  /** Titik fokus, 0..1 dari atas. */
  lensFocusY: number;
  /** Jarak ke titik fokus, meter (0,3..100). */
  lensFocusDistanceM: number;
  /** Panjang fokus, mm (8..600); 0 = lensa normal format. */
  lensFocalLengthMm: number;
  /** Bukaan, f-number (1,2..22). */
  lensFNumber: number;
  /** Bilah iris: 0 = bulat, 5..9. */
  lensBlades: number;
  /** Kelengkungan bilah, 0 lurus .. 1 bulat. */
  lensBladeCurvature: number;
  /** Cat's eye (vignetting optik), 0..1. */
  lensCatEye: number;
  /** Batas dekat zona tajam, meter; 0 = bidang fokus (perilaku lensa). */
  lensNearSharpM: number;
  /** Porsi blur foreground, 0 (dipotong tajam) .. 1 (lensa). */
  lensForeground: number;
}

export const BASELINE_RENDER_PARAMS: Readonly<RenderParams> = Object.freeze({
  process: 'printSimulation',
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
  preflashExposure: 0,
  preflashMFilterShift: 0,
  preflashYFilterShift: 0,
  cameraWhiteBalanceK: 5500,
  cameraExposureEv: 0,
  cameraTint: 0,
  cameraContrast: 0,
  cameraHighlights: 0,
  cameraShadows: 0,
  cameraWhites: 0,
  cameraBlacks: 0,
  cameraSaturation: 1,
  cameraHsvSaturation: 1,
  cameraSoftenDetail: 0,
  lensBlurEnabled: false,
  lensFocusX: 0.5,
  lensFocusY: 0.5,
  lensFocusDistanceM: 2.5,
  lensFocalLengthMm: 0,
  lensFNumber: 2,
  lensBlades: 0,
  lensBladeCurvature: 0.5,
  lensCatEye: 0.35,
  lensNearSharpM: 0,
  lensForeground: 1,
});
