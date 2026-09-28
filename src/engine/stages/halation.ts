import { CORE_PARAMS_BYTES, CORE_PARAMS_WGSL, writeCoreParams } from '../params';
import type { CoreParams } from '../params';
import { Tap } from '../taps';
import type { Stage, StageContext } from '../graph';
import type { Arenas } from '../arena';
import { gpuBufferUsage } from '../webgpuGlobals';
import { SPATIAL_EFFECT_RADIUS_PX } from '../tiling';
import source from '../../shaders/halation.wgsl?raw';

/**
 * Tahap Halation (Task 14): transliterasi `SpektraHalation.comp` (322
 * baris), menutup gerbang `log_e_film` pada keluarga fixture `measured`
 * (`<case>` biasa, BUKAN `_lut`) -- lih. spec §6.3.2/§6.3.3 dan
 * task-11-report.md untuk kenapa `filmExposure.wgsl` SENDIRIAN tidak bisa
 * memproduksi `log_e_film` keluarga ini (halation TIDAK dimatikan
 * `deactivate_stochastic_effects`, hanya `lut_mode`).
 *
 * Posisi rantai: `materializeActiveRegion → filmExposure → halation`.
 * `filmExposure.wgsl` HARUS dijalankan dengan `slot0=1` (raw LINEAR) untuk
 * chain ini -- lih. `test/parity/params.ts::defaultCoreParams`, yang
 * memaksa itu untuk `family: 'measured'`. Tahap ini menjalankan scatter
 * dalam-emulsi, lalu halation refleksi-balik, lalu `log10` SENDIRI sebagai
 * dispatch terakhirnya (persis Python: `apply_halation_um` dipanggil
 * SEBELUM `log10` di `FilmingStage.expose()`).
 *
 * DIPORT: kedua bagian spasial `apply_halation_um` --
 *   1. Scatter (kOpBlurX/BlurYStore untuk core Gaussian; kOpBlurX/
 *      BlurYAccumulate x3 komponen untuk ekor eksponensial, di-dispatch ke
 *      campuran 3-Gaussian PERSIS seperti `fast_exponential_filter`
 *      Python; kOpScatterResolve mencampur core+tail lewat
 *      `scatter_tail_weight`).
 *   2. Halation refleksi-balik (kOpBlurX/BlurYAccumulate x3 bounce dengan
 *      lebar `sqrt(k)`; kOpBounceResolveLog menjumlahkan + men-log10).
 *
 * DIFERRED (lih. task-14-report.md untuk bukti masing-masing):
 *   - `boost_highlights` (kOpBoostMax/BoostReduceMax/BoostApply GLSL).
 *     BUKAN bagian `apply_halation_um` Python -- ia langkah TERPISAH di
 *     `FilmingStage.expose()`, dipanggil SEBELUM `apply_halation_um`.
 *     No-op dibuktikan langsung dari sumber
 *     (`numba_boost_hightlights.py::boost_highlights`: `if boost_ev == 0:
 *     return x.copy()`) DAN `HalationParams.boost_ev` default `0.0`,
 *     tidak pernah disentuh `gen_reference.py` untuk stock
 *     `kodak_portra_400` yang gerbang ini pakai. Tidak diwire ke CoreParams
 *     sama sekali -- kalau task mendatang butuh boost_ev != 0, itu
 *     memerlukan mekanisme baru, bukan tambalan di sini.
 *   - `black_white_filming_exposure_correction()` (dikalikan Python
 *     ANTARA `apply_halation_um` dan `log10`). Warisan cakupan Task 11:
 *     no-op untuk `kodak_portra_400` (negative, bukan black & white) --
 *     dibuktikan di task-11-report.md, berlaku juga di sini karena
 *     perkalian itu terjadi persis di titik yang sama dalam urutan Python.
 *
 * KONSTANTA HARDCODE (bukan dibaca dari arena): lih. blok komentar
 * `halation.wgsl` -- `scatter_core_um`/`scatter_tail_um`/
 * `scatter_tail_weight`/keempat knob amount-scale/`n_bounces`/
 * `bounce_decay`/`renormalize` adalah konstanta skema yang TIDAK PERNAH
 * disentuh `_apply_halation_preset` untuk stock manapun -- hanya
 * `halation_strength`/`halation_first_sigma_um` berubah per stock (dibaca
 * dari arena `stock`, Task 14 menambahkannya di
 * `host/spectral.ts::precomputeArenaData`).
 *
 * `film_format_mm = 35.0` DIHARDCODE di sini (bukan dibaca dari
 * CoreParams -- upstream sendiri tidak membawa field ini di blok
 * push-constant Halation, ia hidup di `ResizingService` Python dan
 * dikonsumsi SEBELUM shader). `CameraParams.film_format_mm` default
 * PERSIS `35.0` dan `gen_reference.py` tidak pernah menimpanya untuk
 * kasus uji manapun yang gerbang ini pakai -- dibuktikan lewat
 * `grep film_format_mm tools/gen_reference.py` (tanpa hasil). Task yang
 * butuh format film lain harus mengalirkan nilai itu lewat parameter baru
 * pada `createHalationStage`, bukan menebak dari sini.
 *
 * `pixel_size_um = film_format_mm * 1000 / max(fullWidth, fullHeight)`
 * (`ResizingService.crop_and_rescale`) dihitung PER-RUN di `encode()` dari
 * `ctx.params.fullWidth/fullHeight` -- BUKAN bagian arena `stock`/
 * `dynamic`/`frameState` manapun, yang semuanya di-cache per `stockId`
 * lintas kasus uji dengan lebar/tinggi BERBEDA (`test/parity/run.ts::
 * sharedResources`) -- membakarnya di sana akan membekukan pixel_size_um
 * kasus uji PERTAMA untuk semua kasus berikutnya yang berbagi stock yang
 * sama, salah secara senyap untuk `color_patches` (8x8) setelah
 * `gray_ramp`/`log_gray_ramp` (32x16) membangun arena itu lebih dulu.
 * Sebagai gantinya tahap ini membuat SATU storage buffer kecil miliknya
 * sendiri (binding 6, "frameFloats"), ditulis ulang tiap `encode()`.
 *
 * ARSITEKTUR MULTI-DISPATCH: `CoreParams` dibagikan SATU KALI per
 * `graph.run()` (`RenderGraph.run()` menulis `paramsBuffer` sekali sebelum
 * loop tahap) -- tapi tahap ini butuh `slot0`(operation)/`slot1`
 * (sigmaMode)/`slot2`(component) BERBEDA di antara 18 dispatch internalnya
 * (persis seperti `SpektraVulkanRenderer.cpp::dispatchHalation` menulis
 * ulang push-constant sebelum tiap `vkCmdDispatch`). WebGPU tidak punya
 * push constant, dan `ctx.paramsBuffer` tidak boleh ditimpa (tahap lain
 * dalam graf yang sama membacanya) -- jadi tahap ini membangun SATU
 * uniform buffer CoreParams kecil PER DISPATCH (18 total), masing-masing
 * dengan slot0/1/2 yang sudah dioverride, lewat `mappedAtCreation` (bukan
 * `queue.writeBuffer`, yang runtutannya relatif terhadap `submit()` tunggal
 * di akhir `graph.run()` akan salah -- lih. catatan `mappedAtCreation` di
 * `arena.ts`). Buffer-buffer kecil ini (112 byte x 18) SENGAJA tidak
 * di-`destroy()` eksplisit -- `encode()` kembali sebelum `submit()`
 * dipanggil pemanggilnya, jadi men-destroy di sini berisiko use-after-
 * destroy dari sisi GPU; total memori yang dilepas ke GC JS (bukan VRAM
 * sungguhan sampai device/proses berakhir) untuk satu run tes berukuran
 * kecil ini diabaikan sengaja, konsisten dengan aturan "kualitas di atas
 * performa".
 *
 * Empat scratch pixel-buffer (`rawA/B/C/D`, meniru `halationRawA..D` GLSL)
 * diperoleh lewat `ctx.scratch()` (pool milik `RenderGraph`), BUKAN
 * `device.createBuffer()` sendiri -- lih. dokumentasi `StageContext.scratch`.
 *
 * Urutan dispatch (mengikuti `dispatchHalation` C++ persis, baris 6452-6469
 * `SpektraVulkanRenderer.cpp`, minus cabang boost):
 *   1. BlurX(ScatterCore)      src   -> rawA
 *   2. BlurYStore(ScatterCore) rawA  -> rawB              (= core Gaussian penuh)
 *   3. Clear                   src(alpha) -> rawC
 *   4. utk c=0..2: BlurX(ScatterTail,c) src->rawA;
 *                  BlurYAccumulate(ScatterTail,c) rawA->rawC += w[c]*blurY  (= tail)
 *   5. ScatterResolve           src,rawB(core),rawC(tail) -> rawD
 *   6. Clear                    rawD(alpha) -> rawC
 *   7. utk k=0..2: BlurX(Bounce,k) rawD->rawA;
 *                  BlurYAccumulate(Bounce,k) rawA->rawC += w[k]*blurY      (= halation_blur)
 *   8. BounceResolveLog         rawD(raw),rawC(halation_blur) -> ctx.dest  (= log_e_film)
 *
 * Kondisi Python `if s_amount>0 and any(sigma_c>0 or lambda_t>0)` (guard
 * scatter) dan `if N>=1 and any(a_tot>0) and any(sigma_h>0)` (guard
 * halation aditif) SELALU benar untuk ke-28 stock: `scatter_amount=1.0`
 * dan `scatter_core_um=(2.2,2.0,1.6)` adalah konstanta skema (selalu > 0),
 * dan SETIAP baris `_HALATION_PRESETS`/`HALATION_PRESETS` (params_builder.py
 * dan generate_profile_curves.py, enam kombinasi (use, antihalation))
 * punya `sigma_h > 0` dan strength kanal-R minimal `0.015 > 0` -- jadi
 * kedua langkah SELALU berjalan, dan tahap ini tidak membutuhkan
 * percabangan host untuk melewatinya.
 */
export function createHalationStage(device: GPUDevice, arenas: Arenas): Stage {
  const arenaConstants = arenas.stock.wgslConstants();

  const module = device.createShaderModule({
    label: 'halation',
    code: `${CORE_PARAMS_WGSL}\n\n${arenaConstants}\n\n${source}`,
  });

  const pipeline = device.createComputePipeline({
    label: 'halation',
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  // Operasi/sigmaMode -- HARUS sama persis dengan konstanta di halation.wgsl.
  const OP_CLEAR = 0;
  const OP_BLUR_X = 1;
  const OP_BLUR_Y_STORE = 2;
  const OP_BLUR_Y_ACCUMULATE = 3;
  const OP_SCATTER_RESOLVE = 4;
  const OP_BOUNCE_RESOLVE_LOG = 5;

  const SIGMA_SCATTER_CORE = 0;
  const SIGMA_SCATTER_TAIL = 1;
  const SIGMA_BOUNCE = 2;


  return {
    name: 'halation',
    writesTaps: [Tap.LOG_E_FILM],
    // Task 19b: port `halationRadius` hulu (`SpektraVulkanRenderer.cpp:5001-5002`,
    // `kVulkanSpatialEffectRadiusPx` -- guard hulu `halationScatterEnabled ||
    // halationBounceEnabled` SELALU true di sini, lih. blok komentar modul
    // di atas: "kedua langkah SELALU berjalan, tahap ini tidak membutuhkan
    // percabangan host untuk melewatinya").
    spatialRadiusPx: SPATIAL_EFFECT_RADIUS_PX,
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const { width, height } = ctx.params;
      const pixelBytes = width * height * 4 * Float32Array.BYTES_PER_ELEMENT;

      const rawA = ctx.scratch('halation:rawA', pixelBytes);
      const rawB = ctx.scratch('halation:rawB', pixelBytes);
      const rawC = ctx.scratch('halation:rawC', pixelBytes);
      const rawD = ctx.scratch('halation:rawD', pixelBytes);
      // Filler untuk binding 1/3 (`pairADst`/`pairBDst`, keduanya
      // `read_write` di WGSL) pada dispatch yang tidak benar-benar
      // memakainya -- WebGPU MENOLAK seluruh command buffer (bukan cuma
      // dispatch itu) kalau buffer yang sama diikat ke DUA binding
      // "writable" (read_write) sekaligus, ATAU ke satu binding writable
      // DAN satu binding lain (read atau write) pada saat bersamaan --
      // "Writable storage buffer binding aliasing", diverifikasi lewat
      // pesan validasi Dawn persis saat ini ditemukan (lih. task-14-report.md).
      // Aturannya statis (dari DEKLARASI akses WGSL, bukan dari cabang mana
      // yang benar-benar dieksekusi), jadi binding 1 dan binding 3 masing-
      // masing HARUS beda dari KETIGA binding pixel lain di setiap dispatch,
      // bahkan ketika operasi itu sendiri tidak pernah membaca/menulisnya.
      // `junk` ada murni untuk mengisi slot writable yang tidak dipakai;
      // binding 0/2 (keduanya `read` di WGSL) BOLEH mengalias satu sama
      // lain dengan aman (dua view baca ke buffer yang sama tidak dilarang).
      const junk = ctx.scratch('halation:junk', pixelBytes);

      const longEdge = Math.max(ctx.params.fullWidth, ctx.params.fullHeight, 1);
      // Fase 2A.5: format film dari `ctx.frame` (dulu konstanta 35.0 di sini).
      const pixelSizeUm = (ctx.frame.filmFormatMm * 1000) / longEdge;

      const frameFloatsBuffer = ctx.device.createBuffer({
        label: 'halation:frameFloats',
        size: 4,
        usage: gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(frameFloatsBuffer.getMappedRange()).set([pixelSizeUm]);
      frameFloatsBuffer.unmap();

      const activeWidth = ctx.params.activeWidth === 0 ? ctx.params.width : ctx.params.activeWidth;
      const activeHeight =
        ctx.params.activeHeight === 0 ? ctx.params.height : ctx.params.activeHeight;
      const groupsX = Math.ceil(activeWidth / 32);
      const groupsY = Math.ceil(activeHeight / 8);

      function makeParamsBuffer(operation: number, sigmaMode: number, component: number): GPUBuffer {
        const overridden: CoreParams = { ...ctx.params, slot0: operation, slot1: sigmaMode, slot2: component };
        const staging = new ArrayBuffer(CORE_PARAMS_BYTES);
        writeCoreParams(overridden, staging);
        const buffer = ctx.device.createBuffer({
          label: `halation:params:${operation}:${sigmaMode}:${component}`,
          size: CORE_PARAMS_BYTES,
          usage: gpuBufferUsage.UNIFORM,
          mappedAtCreation: true,
        });
        new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(staging));
        buffer.unmap();
        return buffer;
      }

      function dispatch(
        operation: number,
        sigmaMode: number,
        component: number,
        b0: GPUBuffer,
        b1: GPUBuffer,
        b2: GPUBuffer,
        b3: GPUBuffer,
      ): void {
        const paramsBuffer = makeParamsBuffer(operation, sigmaMode, component);
        const bindGroup = ctx.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: b0 } },
            { binding: 1, resource: { buffer: b1 } },
            { binding: 2, resource: { buffer: b2 } },
            { binding: 3, resource: { buffer: b3 } },
            { binding: 4, resource: { buffer: paramsBuffer } },
            { binding: 5, resource: { buffer: arenas.stock.buffer } },
            { binding: 6, resource: { buffer: frameFloatsBuffer } },
          ],
        });
        const pass = encoder.beginComputePass({ label: 'halation' });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(groupsX, groupsY, 1);
        pass.end();
      }

      const src = ctx.source;

      // 1-2: scatter core (Gaussian penuh 2D lewat X lalu Y).
      dispatch(OP_BLUR_X, SIGMA_SCATTER_CORE, 0, src, rawA, src, junk);
      dispatch(OP_BLUR_Y_STORE, SIGMA_SCATTER_CORE, 0, rawA, rawB, rawA, junk);

      // 3-4: scatter tail (fast_exponential_filter -- campuran 3-Gaussian).
      dispatch(OP_CLEAR, 0, 0, src, rawC, src, junk);
      for (let c = 0; c < 3; c += 1) {
        dispatch(OP_BLUR_X, SIGMA_SCATTER_TAIL, c, src, rawA, src, junk);
        dispatch(OP_BLUR_Y_ACCUMULATE, SIGMA_SCATTER_TAIL, c, rawA, rawC, rawA, junk);
      }

      // 5: gabungkan core+tail, blend dengan scatter_amount -> rawD.
      dispatch(OP_SCATTER_RESOLVE, 0, 0, src, rawB, rawC, rawD);

      // 6-7: halation refleksi-balik, N=3 bounce lebar sqrt(k).
      dispatch(OP_CLEAR, 0, 0, rawD, rawC, rawD, junk);
      for (let k = 0; k < 3; k += 1) {
        dispatch(OP_BLUR_X, SIGMA_BOUNCE, k, rawD, rawA, rawD, junk);
        dispatch(OP_BLUR_Y_ACCUMULATE, SIGMA_BOUNCE, k, rawA, rawC, rawA, junk);
      }

      // 8: jumlahkan + log10 -> tap log_e_film, ditulis ke ctx.dest.
      dispatch(OP_BOUNCE_RESOLVE_LOG, 0, 0, rawD, rawC, rawD, ctx.dest);
    },
  };
}
