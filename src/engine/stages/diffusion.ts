import { CORE_PARAMS_WGSL } from '../params';
import { Tap } from '../taps';
import type { Stage, StageContext } from '../graph';
import type { Arenas } from '../arena';
import source from '../../shaders/diffusion.wgsl?raw';

/**
 * Tahap Diffusion (Task 15, RESUMED setelah BLOCKED -- lih.
 * `.superpowers/sdd/2026-09-11-dichroic-phase1-engine/task-15-report.md`
 * untuk diagnosis yang menghentikan sesi sebelumnya, dan koreksi di Global
 * Constraints/Task 15 pada `docs/superpowers/plans/2026-09-11-dichroic-
 * phase1-engine.md` yang menghapus larangan "pertahankan jalur piramida").
 *
 * TIDAK MEM-PORT dispatcher piramida `SpektraDiffusion.comp` (downsample/
 * blurX/blurY/upsample lewat campuran-Gaussian OFX). Itu aproksimasi milik
 * shader GPU OFX; `apply_diffusion_filter_um` Python sendiri
 * (`model/diffusion.py:585-639`) memakai konvolusi EKSAK
 * (`scipy.signal.fftconvolve`) terhadap PSF analitik multi-eksponensial.
 * `fftconvolve` dengan kernel hingga == konvolusi spasial langsung dengan
 * kernel yang sama -- diverifikasi terhadap keluaran Python asli di
 * `src/host/diffusionFilter.ts` (JS/f64, ~1e-14) SEBELUM `diffusion.wgsl`
 * ditulis, metode yang sama yang meloloskan Task 12-14 sekali jalan.
 *
 * Posisi rantai kamera: `materializeActiveRegion → filmExposure →
 * diffusion(camera) → halation`, tap `log_e_film` (BUKAN `cmy_film` --
 * draf tugas lama salah di sini, dikoreksi di Global Constraints/Task 15).
 * `filmExposure.wgsl` HARUS dijalankan `slot0=1` (raw LINEAR) untuk chain
 * ini, PERSIS argumen yang sama yang dipakai gerbang Halation (Task 14,
 * `family: 'measured'` di `test/parity/params.ts`) -- diffusion menulis
 * raw linear yang SAMA (bukan log), dan Halation berjalan setelahnya,
 * men-`log10`-kan hasil gabungan sendiri sebagai dispatch terakhirnya.
 * Ini cocok PERSIS urutan Python: `FilmingStage.expose()` memanggil
 * `apply_diffusion_filter_um` (:64) SEBELUM `apply_halation_um` (:68),
 * keduanya sebelum `log10` tunggal di akhir fungsi.
 *
 * DIABAIKAN, SENGAJA, DIBUKTIKAN BUKAN DITEBAK (lih. `filming.py:56-69`):
 *   - `boost_highlights` (`halation.boost_ev`/`boost_range`/`protect_ev`)
 *     berjalan SEBELUM diffusion di Python, tapi sudah dibuktikan no-op
 *     oleh Task 14 (`boost_ev` default `0.0`, tidak pernah disentuh
 *     `gen_reference.py` untuk stock manapun gerbang manapun di sini
 *     pakai) -- alasan yang sama berlaku identik di titik ini.
 *   - `apply_gaussian_blur_um(raw, camera.lens_blur_um, ...)` berjalan
 *     ANTARA diffusion dan halation di Python (`filming.py:67`) -- TIDAK
 *     disebut draf tugas manapun sejauh ini. `CameraParams.lens_blur_um`
 *     default `0.0` (`params_schema.py:53`) dan HANYA disentuh
 *     `params_builder.py` untuk memaksanya ke `0.0` juga (lut_mode/
 *     deactivate branches, baris 90 & 133) -- tidak ada baris kode
 *     manapun di seluruh repo Python yang pernah menyalakannya (`grep -rn
 *     lens_blur_um` menghasilkan hanya deklarasi default + dua penugasan
 *     ke `0.0`). `apply_gaussian_blur_um` sendiri short-circuit untuk
 *     `sigma_um<=0`. No-op untuk SETIAP fixture yang ada, terbukti
 *     langsung dari sumber, bukan diasumsikan dari pola Task 14.
 *
 * PSF host-side: `precomputeDiffusionFilter` (`src/host/diffusionFilter.ts`)
 * dipanggil dari `precomputeArenaData()` (`src/host/spectral.ts`) --
 * SEBELUM `acquireDevice()`, wajib (lih. komentar CATATAN LINGKUNGAN di
 * `spectral.ts`: membangun kernel `(2r+1)x(2r+1)x3` adalah kerja CPU float
 * yang persis jenis yang men-segfault Node bila terjadi setelah device
 * hidup). Tahap ini HANYA membaca arena `dynamic` yang sudah terisi --
 * tidak ada precompute apa pun terjadi di `createDiffusionStage` atau
 * `encode()`.
 *
 * `site` memilih SET ENTRI ARENA mana yang dibaca (`diffusionRadius{Camera,
 * Print}` dkk.), lewat substitusi tekstual nama konstanta WGSL SEBELUM
 * `device.createShaderModule` -- bukan cabang runtime, karena WebGPU tidak
 * mengizinkan memilih offset arena secara dinamis lebih murah daripada itu.
 *
 * SITE 'print' -- DIGERBANGI Task 17 (debt yang dicatat "Selesai Fase 1"
 * pada rencana; lih. `test/parity/diffusion.test.ts`, describe kedua). Task
 * 15 sengaja meninggalkan cabang ini TIDAK PERNAH DIJALANKAN test parity
 * manapun karena `PrintingStage.expose()` Python memanggil
 * `apply_diffusion_filter_um` yang SAMA (`printing.py:56-60`) atas masukan
 * (`raw`) dari `spectral_compute_enlarger`, mesin integrasi spektral penuh
 * yang belum ada portnya saat itu -- merangkai sesuatu di depannya hanya
 * untuk membuat sebuah test "hijau" akan PERSIS "rantai parsial" yang
 * brief larang eksplisit. Task 17 menambahkan port `spectral_compute_
 * enlarger` itu (`printScan.wgsl`'s `expose` entry) DAN fixture baru
 * (`hard_edge_diffusion_print`/`impulse_highlight_diffusion_print`,
 * `enlarger.diffusion_filter.active=True`, `tools/gen_reference.py::
 * _build_params_diffusion_print`), jadi cabang ini sekarang punya
 * pembanding yang sah.
 *
 * SATU PERBEDAAN PERILAKU dari 'camera' (selain nama offset arena):
 * `__DIFFUSION_FINAL_LOG__` disubstitusi `true` untuk 'print' (`camera`
 * tetap `false`, TIDAK BERUBAH dari Task 15) -- lih. komentar
 * `diffusion.wgsl` untuk alasan penuh (tidak ada tahap lain setelah
 * diffusion(print) sebelum tap `log_e_print`, jadi shader ini sendiri
 * yang menutup `log10` tunggal `PrintingStage.expose()`, PERSIS pola
 * `slot0==1u` `filmExposure.wgsl`/`printScan.wgsl`).
 */
export function createDiffusionStage(
  device: GPUDevice,
  arenas: Arenas,
  site: 'camera' | 'print',
): Stage {
  const siteSuffix = site === 'camera' ? 'Camera' : 'Print';
  const code = source
    .replaceAll('__DIFFUSION_RADIUS_OFFSET__', `ARENA_DIFFUSIONRADIUS${siteSuffix.toUpperCase()}_OFFSET`)
    .replaceAll(
      '__DIFFUSION_SCATTER_FRACTION_OFFSET__',
      `ARENA_DIFFUSIONSCATTERFRACTION${siteSuffix.toUpperCase()}_OFFSET`,
    )
    .replaceAll('__DIFFUSION_PSF_OFFSET__', `ARENA_DIFFUSIONPSF${siteSuffix.toUpperCase()}_OFFSET`)
    // Task 17 debt: 'camera' tetap `false` (halation.wgsl yang men-log10-kan,
    // TIDAK berubah dari Task 15). 'print' menjadi `true` -- tidak ada tahap
    // lain setelah diffusion(print) sebelum tap `log_e_print`, jadi shader
    // ini sendiri yang harus menutup `log10` tunggal `PrintingStage.expose()`.
    // Lih. komentar `diffusion.wgsl` untuk rasional penuh.
    .replaceAll('__DIFFUSION_FINAL_LOG__', site === 'print' ? 'true' : 'false');

  const module = device.createShaderModule({
    label: `diffusion:${site}`,
    code: `${CORE_PARAMS_WGSL}\n\n${arenas.dynamic.wgslConstants()}\n\n${code}`,
  });

  const pipeline = device.createComputePipeline({
    label: `diffusion:${site}`,
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  return {
    name: `diffusion:${site}`,
    writesTaps: site === 'camera' ? [Tap.LOG_E_FILM] : [Tap.LOG_E_PRINT],
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const bindGroup = ctx.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ctx.source } },
          { binding: 1, resource: { buffer: ctx.dest } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 3, resource: { buffer: arenas.dynamic.buffer } },
        ],
      });

      const activeWidth = ctx.params.activeWidth === 0 ? ctx.params.width : ctx.params.activeWidth;
      const activeHeight =
        ctx.params.activeHeight === 0 ? ctx.params.height : ctx.params.activeHeight;

      const pass = encoder.beginComputePass({ label: `diffusion:${site}` });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(activeWidth / 32), Math.ceil(activeHeight / 8), 1);
      pass.end();
    },
  };
}
