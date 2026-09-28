import { CORE_PARAMS_BYTES, CORE_PARAMS_WGSL, writeCoreParams } from '../params';
import type { CoreParams } from '../params';
import { GaussianBlur, validInputRect } from '../gaussian';
import type { Vec3 } from '../gaussian';
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

  // Operasi -- HARUS sama persis dengan konstanta di halation.wgsl.
  const OP_SCATTER_RESOLVE = 4;
  const OP_BOUNCE_RESOLVE_LOG = 5;

  const blur = GaussianBlur.shared(device);

  // Parameter `HalationParams` default Python (`params_schema.py:104-126`),
  // sama dengan konstanta `halation.wgsl` -- tidak ada yang terbuka ke UI.
  const SCATTER_SPATIAL_SCALE = 1.0;
  const HALATION_SPATIAL_SCALE = 1.0;
  const SCATTER_CORE_UM: Vec3 = [2.2, 2.0, 1.6];
  const SCATTER_TAIL_UM: Vec3 = [9.3, 9.7, 9.1];
  const N_BOUNCES = 3;
  const BOUNCE_DECAY = 0.5;
  const firstSigmaUm = Array.from(arenas.stock.values('halationFirstSigmaUm')) as Vec3;


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
      const junk = ctx.scratch('halation:junk', pixelBytes);

      // Python `ResizingService.pixel_size_um`: film_format_mm*1000/max(shape),
      // dari dimensi gambar PENUH (bukan tile) -- sama di setiap tile.
      const longEdge = Math.max(ctx.params.fullWidth, ctx.params.fullHeight, 1);
      const pixelSizeUm = (ctx.frame.filmFormatMm * 1000) / longEdge;
      const px = (um: Vec3, scale: number): Vec3 =>
        um.map((v) => Math.max((v * scale) / pixelSizeUm, 1e-6)) as Vec3;

      const rect = validInputRect(ctx.params, SPATIAL_EFFECT_RADIUS_PX);
      const geometry = { bufferWidth: width, bufferHeight: height, rect };

      const activeWidth = ctx.params.activeWidth === 0 ? ctx.params.width : ctx.params.activeWidth;
      const activeHeight =
        ctx.params.activeHeight === 0 ? ctx.params.height : ctx.params.activeHeight;

      function combine(operation: number, b0: GPUBuffer, b1: GPUBuffer, b2: GPUBuffer, b3: GPUBuffer): void {
        const overridden: CoreParams = { ...ctx.params, slot0: operation };
        const staging = new ArrayBuffer(CORE_PARAMS_BYTES);
        writeCoreParams(overridden, staging);
        const paramsBuffer = ctx.device.createBuffer({
          label: `halation:params:${operation}`,
          size: CORE_PARAMS_BYTES,
          usage: gpuBufferUsage.UNIFORM,
          mappedAtCreation: true,
        });
        new Uint8Array(paramsBuffer.getMappedRange()).set(new Uint8Array(staging));
        paramsBuffer.unmap();
        const bindGroup = ctx.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: b0 } },
            { binding: 1, resource: { buffer: b1 } },
            { binding: 2, resource: { buffer: b2 } },
            { binding: 3, resource: { buffer: b3 } },
            { binding: 4, resource: { buffer: paramsBuffer } },
            { binding: 5, resource: { buffer: arenas.stock.buffer } },
          ],
        });
        const pass = encoder.beginComputePass({ label: 'halation' });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(activeWidth / 32), Math.ceil(activeHeight / 8), 1);
        pass.end();
      }

      const src = ctx.source;

      // 1. Scatter: core = G(sigma_c), tail = Exp(lambda_t) (campuran 3 Gaussian).
      blur.encode(encoder, {
        ...geometry,
        src,
        dst: rawB,
        scratch: junk,
        sigma: px(SCATTER_CORE_UM, SCATTER_SPATIAL_SCALE),
      });
      blur.encodeExponential(encoder, {
        ...geometry,
        src,
        dst: rawC,
        component: rawA,
        scratch: junk,
        decay: px(SCATTER_TAIL_UM, SCATTER_SPATIAL_SCALE),
      });
      combine(OP_SCATTER_RESOLVE, src, rawB, rawC, rawD);

      // 2. Bounce: sum_k w_k * G(raw1, sigma_h*sqrt(k)), w = rho^(k-1) / sum.
      let decaySum = 0;
      for (let k = 1; k <= N_BOUNCES; k += 1) decaySum += BOUNCE_DECAY ** (k - 1);
      const sigmaH = firstSigmaUm.map((v) => (v * HALATION_SPATIAL_SCALE) / pixelSizeUm);
      for (let k = 1; k <= N_BOUNCES; k += 1) {
        const sigma = sigmaH.map((v) => Math.max(v * Math.sqrt(k), 1e-6)) as Vec3;
        blur.encode(encoder, { ...geometry, src: rawD, dst: rawA, scratch: junk, sigma });
        blur.encodeScaleAdd(encoder, {
          ...geometry,
          src: rawA,
          dst: rawC,
          scratch: junk,
          amplitude: BOUNCE_DECAY ** (k - 1) / decaySum,
          first: k === 1,
        });
      }

      combine(OP_BOUNCE_RESOLVE_LOG, rawD, rawC, rawD, ctx.dest);
    },
  };
}
