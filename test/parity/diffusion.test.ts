import { describe, it } from 'vitest';
import { createMaterializeActiveRegionStage } from '../../src/engine/stages/materializeActiveRegion';
import { createFilmExposureStage } from '../../src/engine/stages/filmExposure';
import { createHalationStage } from '../../src/engine/stages/halation';
import { createCurveDevelopStage } from '../../src/engine/stages/curveDevelop';
import { createDirStage } from '../../src/engine/stages/dir';
import { createDiffusionStage } from '../../src/engine/stages/diffusion';
import { createPrintExposureStage } from '../../src/engine/stages/printScan';
import { Tap } from '../../src/engine/taps';
import { runTapParity } from './run';

/**
 * Parity gerbang Diffusion kamera (Task 15, RESUMED setelah BLOCKED --
 * lih. task-15-report.md untuk diagnosis lengkap dan koreksi di Global
 * Constraints/Task 15 pada docs/superpowers/plans/2026-09-11-dichroic-
 * phase1-engine.md).
 *
 * Tap `log_e_film` (BUKAN `cmy_film` -- draf tugas lama salah, dikoreksi),
 * keluarga fixture BARU (`hard_edge_diffusion_camera`/
 * `impulse_highlight_diffusion_camera`, `tools/gen_reference.py`) dengan
 * `camera.diffusion_filter.active=True` (default family/strength
 * Python: black_pro_mist, 0.5) -- tidak ada fixture yang sudah ada yang
 * punya diffusion hidup (`DiffusionFilterParams.active` default False,
 * tidak pernah disalakan preset stock manapun).
 *
 * Rantai `materializeActiveRegion → filmExposure → diffusion(camera) →
 * halation`, PERSIS urutan `FilmingStage.expose()` Python
 * (`apply_diffusion_filter_um` sebelum `apply_halation_um`, keduanya
 * sebelum `log10` tunggal). `family: 'measured'` (bukan 'lut') karena
 * lut_mode mematikan diffusion (dan halation) lewat
 * `deactivate_spatial_effects` -- gerbang spasial diukur pada keluarga
 * yang efeknya HIDUP, sama seperti Halation (Task 14).
 *
 * Dua fixture, dipilih deliberately: `hard_edge` menunjukkan penyebaran
 * titik-sebar di seberang tepi tajam (di mana surrogate OFX yang gagal
 * meleset 7.38e-4 -- 74x ambang, lih. task-15-report.md); `impulse_highlight`
 * menunjukkan bentuk kernel dekat r=0 secara langsung (di mana surrogate
 * OFX meleset 1.273e-1 -- 12.730x ambang). Jalur konvolusi-eksak yang
 * menggantikannya diverifikasi host-side (JS/f64 vs Python asli,
 * `src/host/diffusionFilter.ts`) sampai ~1e-14 SEBELUM WGSL ditulis --
 * lih. task-15-report.md untuk skrip dan angka.
 */
describe('parity: diffusion kamera (log_e_film, spasial, diffusion hidup)', () => {
  for (const name of ['hard_edge_diffusion_camera', 'impulse_highlight_diffusion_camera']) {
    it(`cocok dengan referensi Python untuk ${name}`, async () => {
      await runTapParity({
        case: name,
        family: 'measured',
        tap: Tap.LOG_E_FILM,
        tolerance: 1e-5,
        stages: (device, arenas) => [
          createMaterializeActiveRegionStage(device),
          createFilmExposureStage(device, arenas),
          createDiffusionStage(device, arenas, 'camera'),
          createHalationStage(device, arenas),
        ],
      });
    });
  }
});

/**
 * Parity gerbang Diffusion ENLARGER (Task 17 debt -- lih. Global
 * Constraints/Selesai Fase 1 di docs/superpowers/plans/2026-09-11-dichroic-
 * phase1-engine.md: Task 15 mengimplementasikan `createDiffusionStage(...,
 * 'print')` tapi SENGAJA tidak menggerbanginya karena tap `log_e_print`
 * belum ada; Task 17 sekarang menutup itu).
 *
 * Tap `Tap.LOG_E_PRINT`, keluarga fixture BARU
 * (`hard_edge_diffusion_print`/`impulse_highlight_diffusion_print`,
 * `tools/gen_reference.py::_build_params_diffusion_print`) dengan
 * `enlarger.diffusion_filter.active=True` (default family/strength Python:
 * black_pro_mist, 0.5, SAMA persis dengan sisi kamera dan dengan
 * placeholder yang `addPrintScanDynamicData` sudah bakukan sejak Task 17
 * lut_mode gate -- lih. `src/host/spectral.ts`, PSF `diffusionPsfPrint`
 * TIDAK perlu berubah untuk menutup gerbang ini).
 *
 * `_lut` family TIDAK BISA dipakai (lih. instruksi tugas ini dan docstring
 * `_build_params_diffusion_print`): `lut_mode` mempromosikan
 * `deactivate_spatial_effects`, yang memaksa `enlarger.diffusion_filter.
 * active=False` PERSIS efek yang ingin diuji gerbang ini
 * (`params_builder.py:135`). Fixture baru ini karena itu memakai
 * `family: 'measured'` (`deactivate_stochastic_effects` saja, TANPA
 * `lut_mode`) -- SAMA pola dengan diffusion kamera Task 15 di atas -- PLUS
 * dua penyimpangan tambahan yang didokumentasikan penuh di
 * `_build_params_diffusion_print` (`print_exposure_compensation=False`
 * supaya `_compute_exposure_factor_midgray` tetap di cabang non-`_comp`
 * yang sudah diverifikasi ~1e-7 oleh gerbang `_lut`, dan
 * `dir_couplers.diffusion_size_um=0` supaya residual DIR-spasial yang
 * TERBUKTI besar untuk `hard_edge`/`impulse_highlight` -- task-16-report.md
 * -- tidak mencemari `cmy_film`, masukan `PrintingStage.expose()`).
 *
 * Rantai `materializeActiveRegion -> filmExposure -> halation (selesaikan
 * log_e_film) -> curveDevelop -> dir -> printExpose (slot0=1, RAW LINEAR
 * print) -> diffusion(print)` -- PERSIS urutan `FilmingStage.expose()` ->
 * `develop()` -> `PrintingStage.expose()` Python: `apply_diffusion_filter_um`
 * (enlarger) berjalan TEPAT sebelum `log10` tunggal `PrintingStage.expose()`,
 * sama seperti sisi kamera berjalan tepat sebelum `log10` tunggal
 * `FilmingStage.expose()`. `createDiffusionStage(device, arenas, 'print')`
 * (bukan 'camera') menyelesaikan `log10` itu sebagai dispatch TERAKHIRNYA
 * -- pola `slot0==1u` yang sama dengan `filmExposure.wgsl:264`, lih.
 * komentar `printScan.wgsl` untuk detail penuh.
 */
describe('parity: diffusion enlarger (log_e_print, spasial, diffusion hidup)', () => {
  for (const name of ['hard_edge_diffusion_print', 'impulse_highlight_diffusion_print']) {
    it(`cocok dengan referensi Python untuk ${name}`, async () => {
      await runTapParity({
        case: name,
        family: 'measured',
        tap: Tap.LOG_E_PRINT,
        tolerance: 1e-5,
        printScan: {
          printStockId: 'kodak_portra_endura',
          enlargerFilters: {
            cFilterNeutral: 0,
            mFilterNeutral: 51.56801468495496,
            mFilterShift: 0,
            yFilterNeutral: 52.53400422349596,
            yFilterShift: 0,
          },
        },
        stages: (device, arenas) => [
          createMaterializeActiveRegionStage(device),
          createFilmExposureStage(device, arenas),
          createHalationStage(device, arenas),
          createCurveDevelopStage(device, arenas),
          createDirStage(device, arenas),
          createPrintExposureStage(device, arenas),
          createDiffusionStage(device, arenas, 'print'),
        ],
      });
    });
  }
});
