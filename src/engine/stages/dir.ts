import { CORE_PARAMS_BYTES, CORE_PARAMS_WGSL, writeCoreParams } from '../params';
import type { CoreParams } from '../params';
import { Tap } from '../taps';
import type { Stage, StageContext } from '../graph';
import type { Arenas } from '../arena';
import { gpuBufferUsage } from '../webgpuGlobals';
import { GaussianBlur, validInputRect } from '../gaussian';
import { dirRadiusPx } from '../spatialRadius';
import { DEFAULT_DIR_SETTINGS, dirFrameValues } from '../../host/dirCouplers';
import type { FrameParams } from '../graph';
import source from '../../shaders/dir.wgsl?raw';
import { frameBuffer } from '../transient';

/**
 * Tahap Dir (Task 13, diperluas Task 18c): transliterasi `SpektraDir.comp`
 * (`kOpCorrectionFromDensity` + `kOpRedevelop`) PLUS difusi spasial dua-skala
 * `compute_exposure_correction_dir_couplers` yang Task 13 sengaja tunda --
 * lih. blok komentar panjang `dir.wgsl` untuk audit lengkap kenapa
 * penundaan itu SALAH untuk keluarga fixture `measured` BIASA (di mana
 * `dir_couplers.diffusion_size_um` Python TIDAK dinolkan, beda dari
 * `_lut`/`*_diffusion_print`) dan bagaimana Task 18c menemukannya: gerbang
 * deterministik baru `measuredChain.test.ts` di `cmy_film` memerahkan untuk
 * `log_gray_ramp` (1.227e-4 vs ambang 1e-5) SEBELUM perbaikan ini.
 *
 * Ikuti bentuk `createCurveDevelopStage`/draf lama berkas ini: `writesTaps
 * = [Tap.CMY_FILM]`, WAJIB terdaftar tepat SETELAH `createCurveDevelopStage`
 * pada `RenderGraph` yang sama (lih. catatan pengikatan buffer `dir.wgsl`).
 *
 * ARSITEKTUR MULTI-DISPATCH (Task 18c, pola `halation.ts` Task 14 disalin
 * persis -- lih. blok komentar di sana untuk rasional `mappedAtCreation`
 * per-dispatch params, `ctx.scratch`, dan aturan aliasing binding writable):
 *   1. ComputeCorrection: `cmyIn` (density `cmy_film` sebelum koreksi) ->
 *      medan koreksi mentah (`corrRaw`), murni per-piksel, PERSIS rumus
 *      draf lama (`correctionFromDensity`).
 *   2. Gaussian dasar (bobot `1-diffusion_tail_weight`): BlurX lalu
 *      BlurYStore `corrRaw` -> `corrBase`.
 *   3. Ekor eksponensial (bobot `diffusion_tail_weight`, campuran 3-Gaussian
 *      PERSIS `fast_exponential_filter`): Clear `corrTail`; untuk k=0..2:
 *      BlurX `corrRaw` -> tmp; BlurYAccumulate tmp -> `corrTail` +=
 *      amplitude[k]*blurY.
 *   4. Resolve: gabungkan `corrBase`/`corrTail` dengan `kDiffusionTailWeight`
 *      (WGSL, konstanta skema), kurangi dari `logRaw` (`ctx.dest`, MASIH
 *      `log_e_film` pada titik ini), `developFilmDensity`, tulis `cmy_film`
 *      akhir ke `ctx.dest` di TEMPAT (baca-lalu-tulis indeks-sama, invarian
 *      ping-pong yang sama seperti draf lama).
 *
 * KERNEL DIHITUNG DI HOST (JS/f64), BUKAN `exp()` WGSL -- lih. blok komentar
 * `dir.wgsl` untuk alasan (menghindari risiko ULP transcendental WGSL yang
 * Gate A ukur langsung pada `atan2()`, 20-96 ULP di backend ini). Port
 * literal `fast_gaussian_filter.py::_gaussian_kernel_1d` (radius =
 * `int(truncate*sigma+0.5)`, truncate=3.0 default `fast_gaussian_filter`/
 * `fast_exponential_filter`, bobot `exp(-0.5*(x/sigma)^2)` dinormalisasi ke
 * total=1) -- `Math.trunc`/`Math.exp` JS beroperasi f64, PERSIS presisi
 * numba Python di sini (bukan hanya "cukup dekat").
 *
 * KONSTANTA HARDCODE (bukan arena) -- lih. blok komentar `dir.wgsl` untuk
 * bukti `diffusion_size_um`/`diffusion_tail_um`/`diffusion_tail_weight`
 * tidak pernah disentuh preset stock manapun. `FILM_FORMAT_MM=35.0` SAMA
 * dengan `halation.ts`/`diffusion.ts` (`CameraParams.film_format_mm`
 * default, tidak pernah ditimpa `gen_reference.py` untuk kasus uji manapun
 * di repo ini).
 *
 * `pixelSizeUm`/`diffusionSizePixel`/`diffusionTailPixel` dihitung PER-RUN
 * di `encode()` dari `ctx.params.fullWidth/fullHeight` -- BUKAN dibakukan
 * ke arena `stock`/`dynamic` yang di-cache lintas kasus uji ukuran berbeda
 * (`test/parity/run.ts::sharedResources`), PERSIS alasan `halation.ts`'s
 * `frameFloats` (lih. blok komentar di sana) -- membekukannya akan
 * membekukan `pixel_size_um` kasus uji PERTAMA untuk kasus berikutnya yang
 * berbagi stock yang sama tapi resolusi berbeda (`gray_ramp` 32x16 vs
 * `color_patches` 8x8).
 */

// `_EXPONENTIAL_GAUSSIAN_FITS[3]` Python (fast_gaussian_filter.py) --
// (amplitude, sigma_ratio) per komponen campuran, urutan SAMA yang
// `dir.wgsl::tailAmplitude` pakai (kernel index 1/2/3).
/**
 * Fase 2A.5: blur difusi DIR (`couplers.py:104`) lewat primitif bersama
 * `GaussianBlur` -- `(1-w)*G(size_px) + w*Exp(tail_px)` pada koreksi log-raw,
 * termasuk jalur IIR Young-van Vliet untuk sigma >= 3 px. Kernel FIR sendiri
 * yang dulu ada di sini (radius maks 16, melempar di atasnya) hanya menutup
 * ukuran piksel fixture Fase 1; di foto sungguhan (6 um/px) sigma difusi ~3 px
 * dan komponen ekornya sampai ~90 px.
 */

export interface DirStageOptions {
  /**
   * Default `true` (mencerminkan default Python `DirCouplersParams.
   * diffusion_size_um=20.0`, SPASIAL, lih. blok komentar berkas ini dan
   * `dir.wgsl`). `lut_mode` (`deactivate_spatial_effects`) DAN fixture
   * `*_diffusion_print` (Task 17, `tools/gen_reference.py::
   * _build_params_diffusion_print`) MENOLKAN `diffusion_size_um` secara
   * eksplisit di Python -- pemanggil yang merepresentasikan keluarga itu
   * HARUS memberi `false` di sini, PERSIS pola `bypassConvolution`
   * (`createDiffusionStage`). `false` membuat KEEMPAT kernel (dasar + tiga
   * komponen ekor) bersigma 0 -> radius-0 -> identitas murni, yang secara
   * ALJABAR mereduksi rumus resolve (`(1-w)*corrBase + w*corrTail`) balik
   * ke `corrRaw` PERSIS -- SAMA dengan draf lama berkas ini (Task 13)
   * sebelum Task 18c menambahkan istilah spasial, bukan pendekatan baru.
   */
  spatialDiffusionActive?: boolean;
  /** Neutral negative redevelops Cineon density, never the selected stock curve. */
  neutralFilm?: boolean;
}

export function createDirStage(device: GPUDevice, arenas: Arenas, options?: DirStageOptions): Stage {
  const spatialDiffusionActive = options?.spatialDiffusionActive ?? true;
  const arenaConstants = arenas.stock.wgslConstants();

  const module = device.createShaderModule({
    label: 'dir',
    code: `${CORE_PARAMS_WGSL}\n\n${arenaConstants}\n\nconst NEUTRAL_FILM: bool = ${options?.neutralFilm === true};\n${source}`,
  });

  const pipeline = device.createComputePipeline({
    label: 'dir',
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  // Op/kernel-index -- HARUS sama persis dengan konstanta di dir.wgsl.
  const OP_COMPUTE_CORRECTION = 0;
  const OP_RESOLVE = 5;

  const blur = GaussianBlur.shared(device);


  const DIFFUSION_TAIL_UM = 200.0; // `DirCouplersParams.diffusion_tail_um` default, konstanta skema.
  const DEFAULT_DIFFUSION_SIZE_UM = 20.0; // `DirCouplersParams.diffusion_size_um` default.

  // Fase 2D: `dirFrame` (binding 6) -- matriks dan kurva sebelum DIR untuk
  // `amount`/`inhibition_*` render ini, dihitung host dari gamma stock.
  // Di-memo per kombinasi supaya render ter-tile tidak menghitung ulang.
  const gammas = arenas.stock.values('dirGammas');
  const densityCurves = arenas.stock.values('densityCurves');
  const packedExposure = arenas.stock.values('curveExposure');
  const logExposure = new Float32Array(packedExposure.length / 2);
  for (let i = 0; i < logExposure.length; i += 1) logExposure[i] = packedExposure[i * 2]!;
  const positive = arenas.stock.values('dirIsPositive')[0]! > 0.5;
  const memo = new Map<string, Float32Array>();
  function frameValues(frame: Readonly<FrameParams>): Float32Array {
    const settings = {
      amount: frame.dirCouplersAmount ?? DEFAULT_DIR_SETTINGS.amount,
      inhibitionSameLayer: frame.dirInhibitionSameLayer ?? DEFAULT_DIR_SETTINGS.inhibitionSameLayer,
      inhibitionInterlayer: frame.dirInhibitionInterlayer ?? DEFAULT_DIR_SETTINGS.inhibitionInterlayer,
    };
    const key = `${settings.amount}|${settings.inhibitionSameLayer}|${settings.inhibitionInterlayer}`;
    let values = memo.get(key);
    if (!values) {
      values = dirFrameValues(gammas, densityCurves, logExposure, positive, settings);
      memo.set(key, values);
    }
    return values;
  }
  const diffusionUmOf = (frame: Readonly<FrameParams>) =>
    spatialDiffusionActive ? (frame.dirDiffusionUm ?? DEFAULT_DIFFUSION_SIZE_UM) : 0;

  return {
    name: 'dir',
    writesTaps: [Tap.CMY_FILM],
    // Task 19b: port `dirRadius` hulu (`SpektraVulkanRenderer.cpp:5001`,
    // `dirBlurPath ? kVulkanSpatialEffectRadiusPx : 0u`) -- `dirBlurPath`
    // hulu artinya "kernel DIR benar-benar spasial", PERSIS
    // `spatialDiffusionActive` di sini (`false` => keempat kernel
    // radius-0/identitas, lih. `DirStageOptions` di atas).
    // Fase 2A.5: radius dari sigma blur sebenarnya (lih. `spatialRadius.ts`).
    spatialRadiusPx: spatialDiffusionActive
      ? (params, frame) =>
          dirRadiusPx((frame.filmFormatMm * 1000) / Math.max(params.fullWidth, params.fullHeight, 1), diffusionUmOf(frame))
      : 0,
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const { width, height } = ctx.params;
      const pixelBytes = width * height * 4 * Float32Array.BYTES_PER_ELEMENT;

      const corrRaw = ctx.scratch('dir:corrRaw', pixelBytes);
      const corrBase = ctx.scratch('dir:corrBase', pixelBytes);
      const corrTail = ctx.scratch('dir:corrTail', pixelBytes);
      const blurTmp = ctx.scratch('dir:blurTmp', pixelBytes);
      const junk = ctx.scratch('dir:junk', pixelBytes);

      // Fase 2A.5: format film dari `ctx.frame` (dulu konstanta 35.0 di sini).
      const longEdge = Math.max(ctx.params.fullWidth, ctx.params.fullHeight, 1);
      const pixelSizeUm = (ctx.frame.filmFormatMm * 1000) / longEdge;
      // Python: `diffusion_size_um > 0` menyalakan KEDUA skala (dasar dan ekor).
      const diffusionUm = diffusionUmOf(ctx.frame);
      const spatial = diffusionUm > 0;
      const diffusionSizePixel = spatial ? diffusionUm / pixelSizeUm : 0;
      const diffusionTailPixel = spatial ? DIFFUSION_TAIL_UM / pixelSizeUm : 0;

      const dirValues = frameValues(ctx.frame);
      const dirFrameBuffer = frameBuffer(ctx, {
        label: 'dir:frame',
        size: dirValues.byteLength,
        usage: gpuBufferUsage.STORAGE,
        mappedAtCreation: true,
      });
      new Float32Array(dirFrameBuffer.getMappedRange()).set(dirValues);
      dirFrameBuffer.unmap();

      const activeWidth = ctx.params.activeWidth === 0 ? ctx.params.width : ctx.params.activeWidth;
      const activeHeight =
        ctx.params.activeHeight === 0 ? ctx.params.height : ctx.params.activeHeight;
      const groupsX = Math.ceil(activeWidth / 32);
      const groupsY = Math.ceil(activeHeight / 8);

      function dispatch(operation: number, b0: GPUBuffer, b1: GPUBuffer, b2: GPUBuffer, b3: GPUBuffer): void {
        const overridden: CoreParams = {
          ...ctx.params,
          slot0: operation,
          slot1: spatial ? 1 : 0,
          slot2: 0,
        };
        const staging = new ArrayBuffer(CORE_PARAMS_BYTES);
        writeCoreParams(overridden, staging);
        const paramsBuffer = frameBuffer(ctx, {
          label: `dir:params:${operation}`,
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
            { binding: 6, resource: { buffer: dirFrameBuffer } },
          ],
        });
        const pass = encoder.beginComputePass({ label: 'dir' });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(groupsX, groupsY, 1);
        pass.end();
      }

      const src = ctx.source; // cmy_film density SEBELUM koreksi DIR (keluaran curveDevelop).

      dispatch(OP_COMPUTE_CORRECTION, src, corrRaw, src, junk);

      // Blur hanya di dalam active rect: di bawah tiling apron-menyusut, itu
      // satu-satunya wilayah tempat koreksi baru saja dihitung (lih.
      // `validInputRect`).
      const geometry = { bufferWidth: width, bufferHeight: height, rect: validInputRect(ctx.params), ...(ctx.transient ? { transient: ctx.transient } : {}) };
      const size = diffusionSizePixel;
      blur.encode(encoder, { ...geometry, src: corrRaw, dst: corrBase, scratch: junk, sigma: [size, size, size] });
      if (spatial) {
        const tail = diffusionTailPixel;
        blur.encodeExponential(encoder, {
          ...geometry,
          src: corrRaw,
          dst: corrTail,
          component: blurTmp,
          scratch: junk,
          decay: [tail, tail, tail],
        });
      }

      dispatch(OP_RESOLVE, corrBase, junk, corrTail, ctx.dest);
    },
  };
}
