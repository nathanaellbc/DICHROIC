/**
 * Preflash kertas (Fase 2D Task 2): port `PrintingStage._compute_raw_preflash`
 * (`runtime/stages/printing.py:93-99`) dan `EnlargerService.
 * preflash_filtered_illuminant` (`filter_enlarger_source.py`).
 *
 *   raw_preflash = contract(density_to_light(base_density, preflash_illuminant),
 *                           sensitivity) * preflash_exposure
 *
 * dengan `preflash_illuminant` = TH-KG3 lewat filter enlarger yang SAMA
 * (C netral, M/Y netral) ditambah shift preflash sendiri. Hasilnya satu
 * vektor 3 kanal per render, konstan per piksel, yang Python tambahkan ke
 * raw print SETELAH faktor midgray dan SEBELUM `print_exposure`.
 * `preflash_exposure <= 0` -> nol (Python mengembalikan `np.zeros((3,))`).
 */
import { filteredEnlargerIlluminant } from './enlarger';

export interface PreflashTables {
  /** `standard_illuminant(enlarger.illuminant)` (TH-KG3). */
  lightSource: ArrayLike<number>;
  /** Transmitansi filter dichroic (nWave x 3, kolom C/M/Y). */
  customEnlargerFilters: ArrayLike<number>;
  /** Filter netral arena ini: [C (termasuk filterC), M, Y] (Kodak CC). */
  neutralCmy: ArrayLike<number>;
  /** `film.data.base_density` (nWave; bisa NaN). */
  baseDensity: ArrayLike<number>;
  /** `10**print.log_sensitivity` dengan NaN -> 0 (nWave x 3). */
  printLinearSensitivity: ArrayLike<number>;
}

export interface PreflashSettings {
  exposure: number;
  mFilterShift: number;
  yFilterShift: number;
}

export function preflashRaw(tables: PreflashTables, settings: PreflashSettings): [number, number, number] {
  if (!(settings.exposure > 0)) return [0, 0, 0];
  const illuminant = filteredEnlargerIlluminant(tables.lightSource, tables.customEnlargerFilters, {
    cFilterNeutral: tables.neutralCmy[0]!,
    mFilterNeutral: tables.neutralCmy[1]!,
    mFilterShift: settings.mFilterShift,
    yFilterNeutral: tables.neutralCmy[2]!,
    yFilterShift: settings.yFilterShift,
  });
  const out: [number, number, number] = [0, 0, 0];
  for (let wl = 0; wl < illuminant.length; wl += 1) {
    // `density_to_light`: 10**-density * light, NaN -> 0 setelah transmitansi.
    const light = 10 ** -tables.baseDensity[wl]! * illuminant[wl]!;
    if (Number.isNaN(light)) continue;
    for (let c = 0; c < 3; c += 1) out[c] = out[c]! + light * tables.printLinearSensitivity[wl * 3 + c]!;
  }
  return [out[0] * settings.exposure, out[1] * settings.exposure, out[2] * settings.exposure];
}
