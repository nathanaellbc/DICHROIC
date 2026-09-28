import { CORE_PARAMS_BYTES, CORE_PARAMS_WGSL, writeCoreParams } from '../params';
import type { CoreParams } from '../params';
import { Tap } from '../taps';
import type { Stage, StageContext } from '../graph';
import type { Arenas } from '../arena';
import { gpuBufferUsage } from '../webgpuGlobals';
import { SPATIAL_EFFECT_RADIUS_PX } from '../tiling';
import source from '../../shaders/dir.wgsl?raw';

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
const TAIL_MIXTURE: ReadonlyArray<{ amplitude: number; sigmaRatio: number }> = [
  { amplitude: 0.1633, sigmaRatio: 0.536 },
  { amplitude: 0.6496, sigmaRatio: 1.5236 },
  { amplitude: 0.187, sigmaRatio: 2.7684 },
];

const GAUSSIAN_TRUNCATE = 3.0; // default `fast_gaussian_filter`/`fast_exponential_filter` truncate.
const MAX_KERNEL_RADIUS = 16; // lih. `dir.wgsl::kMaxKernelRadius` -- headroom jauh di atas radius terukur (2).
const KERNEL_STRIDE = 1 + 2 * MAX_KERNEL_RADIUS + 1; // 1 (radius) + 33 bobot terpad-nol.

/**
 * Port literal `fast_gaussian_filter.py::_gaussian_kernel_1d` (f64 JS,
 * PERSIS presisi numba Python) -- lih. blok komentar modul. `sigma<=0`
 * (tidak pernah terjadi untuk `diffusion_size_um=20`/`diffusion_tail_um
 * =200` yang selalu >0, tapi dijaga defensif) mengembalikan kernel
 * identitas radius-0, PERSIS `_gaussian_filter_2d_small`'s short-circuit.
 */
function gaussianKernel1D(sigma: number): { radius: number; weights: number[] } {
  if (!(sigma > 0)) {
    return { radius: 0, weights: [1] };
  }
  const radius = Math.trunc(GAUSSIAN_TRUNCATE * sigma + 0.5);
  const size = 2 * radius + 1;
  const weights = new Array<number>(size);
  let total = 0;
  for (let i = 0; i < size; i += 1) {
    const x = i - radius;
    const value = Math.exp(-0.5 * (x / sigma) ** 2);
    weights[i] = value;
    total += value;
  }
  for (let i = 0; i < size; i += 1) {
    weights[i] = weights[i]! / total;
  }
  if (radius > MAX_KERNEL_RADIUS) {
    throw new Error(
      `dir.ts: kernel radius ${radius} melebihi kMaxKernelRadius=${MAX_KERNEL_RADIUS} -- ` +
        'gambar ini mendorong diffusion_size_pixel ke rezim yang butuh dispatch IIR ' +
        'Young-van Vliet (lih. blok komentar dir.wgsl, "LINGKUP YANG SENGAJA TIDAK DIPORT"), ' +
        'bukan sekadar menaikkan MAX_KERNEL_RADIUS.',
    );
  }
  return { radius, weights };
}

/** Menulis satu kernel (radius + bobot terpad-nol) ke slot `kernelIndex` dalam `out`. */
function packKernel(out: Float32Array, kernelIndex: number, sigma: number): void {
  const { radius, weights } = gaussianKernel1D(sigma);
  const base = kernelIndex * KERNEL_STRIDE;
  out[base] = radius;
  for (let o = -radius; o <= radius; o += 1) {
    out[base + 1 + o + MAX_KERNEL_RADIUS] = weights[o + radius]!;
  }
}

/**
 * Kernel 0 = Gaussian dasar (`diffusion_size_pixel`, rasio 1.0); kernel 1-3
 * = tiga komponen campuran ekor eksponensial (`diffusion_tail_pixel *
 * sigmaRatio[k]`), urutan SAMA `TAIL_MIXTURE`/`dir.wgsl::tailAmplitude`.
 */
function buildKernelBuffer(diffusionSizePixel: number, diffusionTailPixel: number): Float32Array {
  const out = new Float32Array(4 * KERNEL_STRIDE);
  packKernel(out, 0, diffusionSizePixel);
  TAIL_MIXTURE.forEach((component, i) => {
    packKernel(out, i + 1, diffusionTailPixel * component.sigmaRatio);
  });
  return out;
}

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
}

export function createDirStage(device: GPUDevice, arenas: Arenas, options?: DirStageOptions): Stage {
  const spatialDiffusionActive = options?.spatialDiffusionActive ?? true;
  const arenaConstants = arenas.stock.wgslConstants();

  const module = device.createShaderModule({
    label: 'dir',
    code: `${CORE_PARAMS_WGSL}\n\n${arenaConstants}\n\n${source}`,
  });

  const pipeline = device.createComputePipeline({
    label: 'dir',
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  // Op/kernel-index -- HARUS sama persis dengan konstanta di dir.wgsl.
  const OP_COMPUTE_CORRECTION = 0;
  const OP_CLEAR = 1;
  const OP_BLUR_X = 2;
  const OP_BLUR_Y_STORE = 3;
  const OP_BLUR_Y_ACCUMULATE = 4;
  const OP_RESOLVE = 5;

  const KERNEL_BASE = 0;

  const DIFFUSION_SIZE_UM = 20.0; // `DirCouplersParams.diffusion_size_um` default, konstanta skema.
  const DIFFUSION_TAIL_UM = 200.0; // `DirCouplersParams.diffusion_tail_um` default, konstanta skema.

  return {
    name: 'dir',
    writesTaps: [Tap.CMY_FILM],
    // Task 19b: port `dirRadius` hulu (`SpektraVulkanRenderer.cpp:5001`,
    // `dirBlurPath ? kVulkanSpatialEffectRadiusPx : 0u`) -- `dirBlurPath`
    // hulu artinya "kernel DIR benar-benar spasial", PERSIS
    // `spatialDiffusionActive` di sini (`false` => keempat kernel
    // radius-0/identitas, lih. `DirStageOptions` di atas).
    spatialRadiusPx: spatialDiffusionActive ? SPATIAL_EFFECT_RADIUS_PX : 0,
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const { width, height } = ctx.params;
      const pixelBytes = width * height * 4 * Float32Array.BYTES_PER_ELEMENT;

      const corrRaw = ctx.scratch('dir:corrRaw', pixelBytes);
      const corrBase = ctx.scratch('dir:corrBase', pixelBytes);
      const corrTail = ctx.scratch('dir:corrTail', pixelBytes);
      const blurTmp = ctx.scratch('dir:blurTmp', pixelBytes);
      // Filler binding writable tak terpakai -- lih. catatan aliasing
      // panjang `halation.ts` (disalin persis): setiap binding writable
      // (1/3) HARUS beda dari KETIGA binding lain di dispatch yang sama,
      // bahkan saat operasi itu tidak membaca/menulisnya.
      const junk = ctx.scratch('dir:junk', pixelBytes);

      const longEdge = Math.max(ctx.params.fullWidth, ctx.params.fullHeight, 1);
      // Fase 2A.5: format film dari `ctx.frame` (dulu konstanta 35.0 di sini).
      const pixelSizeUm = (ctx.frame.filmFormatMm * 1000) / longEdge;
      // `spatialDiffusionActive=false`: keempat sigma 0 -> keempat kernel
      // radius-0 (identitas) -> resolve mereduksi ke `corrRaw` murni,
      // PERSIS `diffusion_size_pixel<=0` Python. Lih. `DirStageOptions`.
      const diffusionSizePixel = spatialDiffusionActive ? DIFFUSION_SIZE_UM / pixelSizeUm : 0;
      const diffusionTailPixel = spatialDiffusionActive ? DIFFUSION_TAIL_UM / pixelSizeUm : 0;

      const kernelData = buildKernelBuffer(diffusionSizePixel, diffusionTailPixel);
      const kernelBuffer = ctx.device.createBuffer({
        label: 'dir:kernel',
        size: kernelData.byteLength,
        usage: gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(kernelBuffer.getMappedRange()).set(kernelData);
      kernelBuffer.unmap();

      const activeWidth = ctx.params.activeWidth === 0 ? ctx.params.width : ctx.params.activeWidth;
      const activeHeight =
        ctx.params.activeHeight === 0 ? ctx.params.height : ctx.params.activeHeight;
      const groupsX = Math.ceil(activeWidth / 32);
      const groupsY = Math.ceil(activeHeight / 8);

      function makeParamsBuffer(operation: number, kernelIndex: number): GPUBuffer {
        // `slot1` (dir.wgsl's `kOpResolve` SAJA yang membacanya, 0/1) --
        // lih. `DirStageOptions`/`dir.wgsl` untuk kenapa cabang eksplisit
        // ini (bukan hanya sigma=0) wajib untuk bit-exact.
        const overridden: CoreParams = {
          ...ctx.params,
          slot0: operation,
          slot1: spatialDiffusionActive ? 1 : 0,
          slot2: kernelIndex,
        };
        const staging = new ArrayBuffer(CORE_PARAMS_BYTES);
        writeCoreParams(overridden, staging);
        const buffer = ctx.device.createBuffer({
          label: `dir:params:${operation}:${kernelIndex}`,
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
        kernelIndex: number,
        b0: GPUBuffer,
        b1: GPUBuffer,
        b2: GPUBuffer,
        b3: GPUBuffer,
      ): void {
        const paramsBuffer = makeParamsBuffer(operation, kernelIndex);
        const bindGroup = ctx.device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: b0 } },
            { binding: 1, resource: { buffer: b1 } },
            { binding: 2, resource: { buffer: b2 } },
            { binding: 3, resource: { buffer: b3 } },
            { binding: 4, resource: { buffer: paramsBuffer } },
            { binding: 5, resource: { buffer: arenas.stock.buffer } },
            { binding: 6, resource: { buffer: kernelBuffer } },
          ],
        });
        const pass = encoder.beginComputePass({ label: 'dir' });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(groupsX, groupsY, 1);
        pass.end();
      }

      const src = ctx.source; // cmy_film density SEBELUM koreksi DIR (keluaran curveDevelop).

      // 1: medan koreksi mentah, murni per-piksel.
      dispatch(OP_COMPUTE_CORRECTION, KERNEL_BASE, src, corrRaw, src, junk);

      // 2: Gaussian dasar (radius 0 -- identitas -- untuk fixture yang ada,
      // lih. blok komentar dir.wgsl; diport penuh untuk benar di luar itu).
      dispatch(OP_BLUR_X, KERNEL_BASE, corrRaw, blurTmp, corrRaw, junk);
      dispatch(OP_BLUR_Y_STORE, KERNEL_BASE, blurTmp, corrBase, blurTmp, junk);

      // 3: ekor eksponensial -- campuran 3-Gaussian PERSIS `fast_exponential_filter`.
      dispatch(OP_CLEAR, KERNEL_BASE, corrRaw, corrTail, corrRaw, junk);
      TAIL_MIXTURE.forEach((_component, i) => {
        const kernelIndex = i + 1;
        dispatch(OP_BLUR_X, kernelIndex, corrRaw, blurTmp, corrRaw, junk);
        // `kOpBlurYAccumulate` (dir.wgsl) membaca+menulis `pairBDst` (binding 3,
        // BUKAN `pairADst`/binding 1 seperti op lain) -- akumulator harus di b3.
        dispatch(OP_BLUR_Y_ACCUMULATE, kernelIndex, blurTmp, junk, blurTmp, corrTail);
      });

      // 4: gabungkan (kDiffusionTailWeight, WGSL), kurangi dari logRaw
      // (ctx.dest, MASIH log_e_film), develop, tulis cmy_film akhir di tempat.
      dispatch(OP_RESOLVE, KERNEL_BASE, corrBase, junk, corrTail, ctx.dest);
    },
  };
}
