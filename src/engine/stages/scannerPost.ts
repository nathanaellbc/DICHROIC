import { CORE_PARAMS_WGSL } from '../params';
import { Tap } from '../taps';
import type { Stage, StageContext } from '../graph';
import type { Arenas } from '../arena';
import { gpuBufferUsage } from '../webgpuGlobals';
import { SPATIAL_EFFECT_RADIUS_PX } from '../tiling';
import source from '../../shaders/scannerPost.wgsl?raw';

const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;

/**
 * Task 18c -- `scanner.unsharp_mask` Python: `sigma=amount=0.7`, KONSTANTA
 * (lih. blok komentar `scannerPost.wgsl` dekat binding 8-11 untuk bukti
 * lengkap tidak pernah disentuh preset stock manapun). `sigma` dipakai
 * LANGSUNG sebagai piksel (BEDA dari DIR/Halation/Diffusion -- `scanning.py`
 * tidak mengonversi lewat `pixel_size_um` di titik ini sama sekali).
 */
const UNSHARP_SIGMA_PX = 0.7;

/** `GlareParams.roughness` default; `sigma2 = ln(1 + roughness^2)` (`fast_lognormal_from_mean_std`). */
const GLARE_ROUGHNESS = 0.7;

/**
 * Fase 2C: mu lognormal glare untuk `percent` (mean linear), `ln(m) - sigma2/2`.
 * Percent <= 0 tidak pernah dibaca (`add_glare` melewati glare; plan
 * memadamkan `FLAG_GLARE_ACTIVE`), jadi dikembalikan 0 yang terhingga.
 */
export function glareLogMu(percent: number): number {
  if (!(percent > 0)) return 0;
  return Math.log(percent) - Math.log(1 + GLARE_ROUGHNESS ** 2) / 2;
}
const GAUSSIAN_TRUNCATE = 3.0; // default `fast_gaussian_filter` truncate.
const MAX_KERNEL_RADIUS = 16; // lih. dir.ts -- headroom jauh di atas radius terpakai (2).
const KERNEL_STRIDE = 1 + 2 * MAX_KERNEL_RADIUS + 1; // 1 (radius) + 33 bobot terpad-nol.

/**
 * Port literal `fast_gaussian_filter.py::_gaussian_kernel_1d` (f64 JS) --
 * DUPLIKAT SENGAJA dari `dir.ts::gaussianKernel1D`/`packKernel` (bukan
 * diimpor): setiap shader/tahap di repo ini berdiri sendiri, pola yang
 * sama dipakai `halation.wgsl`/`dir.wgsl` untuk tabel `_EXPONENTIAL_
 * GAUSSIAN_FITS`. Lih. `dir.ts` untuk penjelasan lengkap kenapa kernel
 * dihitung host (f64) alih-alih `exp()` WGSL (risiko ULP transcendental,
 * Gate A mengukur `atan2()` 20-96 ULP di backend ini).
 */
function buildUnsharpKernelBuffer(sigma: number): Float32Array {
  const out = new Float32Array(KERNEL_STRIDE);
  const radius = Math.trunc(GAUSSIAN_TRUNCATE * sigma + 0.5);
  if (radius > MAX_KERNEL_RADIUS) {
    throw new Error(
      `scannerPost.ts: kernel radius unsharp ${radius} melebihi MAX_KERNEL_RADIUS=${MAX_KERNEL_RADIUS}.`,
    );
  }
  const size = 2 * radius + 1;
  const weights = new Array<number>(size);
  let total = 0;
  for (let i = 0; i < size; i += 1) {
    const x = i - radius;
    const value = Math.exp(-0.5 * (x / sigma) ** 2);
    weights[i] = value;
    total += value;
  }
  out[0] = radius;
  for (let o = -radius; o <= radius; o += 1) {
    out[1 + o + MAX_KERNEL_RADIUS] = weights[o + radius]! / total;
  }
  return out;
}

/**
 * Tahap ScannerPost (Task 18): EMPAT entry point WGSL dari SATU modul --
 * `glareGenerate`->`glareBlurX`->`glareBlurY` (Gate B, `add_glare`) lalu
 * `scan` (Gate A+B, tap `rgb_out`) -- port `ScanningStage.scan()` Python
 * (`runtime/stages/scanning.py:46-50`). Ini tahap TERAKHIR pipeline;
 * setelahnya rantai selesai ujung ke ujung (lih. `test/parity/chain.ts`).
 *
 * Cakupan gerbang `_lut` (Gate A) dan `_stochastic` (Gate B, `add_glare`)
 * dan alasan lengkap tiap istilah yang TIDAK diimplementasikan
 * (blur/unsharp, koreksi white/black -- TERBUKTI no-op untuk KEDUA
 * keluarga) ada di blok komentar berkas `scannerPost.wgsl`, bukan
 * diulang di sini.
 *
 * TIGA dispatch glare menulis scratch SKALAR (satu float per piksel,
 * `ctx.scratch()` -- pola SAMA `grain.ts`, lih. blok komentar di sana
 * untuk kenapa `layout: 'auto'` per-pipeline aman dari aliasing
 * read_write) SEBELUM `scan` membacanya. Ketiganya SELALU berjalan
 * (murah, gambar uji kecil) TERLEPAS dari family -- yang membedakan Gate
 * A (`_lut`) dari Gate B (`_stochastic`) adalah `scan` sendiri MEMBUANG
 * kontribusi itu lewat `FLAG_GLARE_ACTIVE` (bit 2 `slot1`,
 * `src/engine/params.ts`): `defaultCoreParams` (`test/parity/params.ts`)
 * menyalakannya HANYA untuk `family: 'measured'`, mencerminkan
 * `print_render.glare.active` Python (`lut_mode` memaksa
 * `deactivate_stochastic_effects=True` -> `glare.active=False`,
 * `params_builder.py::digest_params`) -- TANPA gerbang ini Gate A akan
 * kena derau yang Python sendiri tidak pernah terapkan untuk fixture
 * `_lut`. Diverifikasi: Gate A tetap 3/3 exact di angka SAMA (1.848e-6/
 * 1.043e-6/1.781e-6) setelah Gate B ditambahkan -- lih. task-18-report.md.
 *
 * `arenas.dynamic` HARUS sudah diaugmentasi lewat `addScannerPostDynamicData`
 * (dipanggil `precomputeArenaData(bundle, filmStockId, { printStockId,
 * enlargerFilters })` -- SAMA opsi yang `printScan.ts` butuhkan, karena
 * `rgb_out` mencetak PRINT, bukan FILM). `arenas.static` HARUS sudah
 * membawa `standardObserverCmfs` (ditambahkan Task 18 ke `precomputeArenaData`
 * TANPA SYARAT, bukan hanya ketika `printScan` diberikan -- lih.
 * `src/host/spectral.ts`).
 */
export function createScannerPostStage(device: GPUDevice, arenas: Arenas): Stage {
  const arenaConstants = `${arenas.static.wgslConstants()}\n\n${arenas.dynamic.wgslConstants()}`;

  const module = device.createShaderModule({
    label: 'scannerPost:scan',
    code: `${CORE_PARAMS_WGSL}\n\n${arenaConstants}\n\n${source}`,
  });

  const scanPreUnsharpPipeline = device.createComputePipeline({
    label: 'scannerPost:scanPreUnsharp',
    layout: 'auto',
    compute: { module, entryPoint: 'scanPreUnsharp' },
  });
  const unsharpBlurXPipeline = device.createComputePipeline({
    label: 'scannerPost:unsharpBlurX',
    layout: 'auto',
    compute: { module, entryPoint: 'unsharpBlurX' },
  });
  const unsharpBlurYPipeline = device.createComputePipeline({
    label: 'scannerPost:unsharpBlurY',
    layout: 'auto',
    compute: { module, entryPoint: 'unsharpBlurY' },
  });
  const scanPipeline = device.createComputePipeline({
    label: 'scannerPost:scan',
    layout: 'auto',
    compute: { module, entryPoint: 'scan' },
  });
  const glareGeneratePipeline = device.createComputePipeline({
    label: 'scannerPost:glareGenerate',
    layout: 'auto',
    compute: { module, entryPoint: 'glareGenerate' },
  });
  const glareBlurXPipeline = device.createComputePipeline({
    label: 'scannerPost:glareBlurX',
    layout: 'auto',
    compute: { module, entryPoint: 'glareBlurX' },
  });
  const glareBlurYPipeline = device.createComputePipeline({
    label: 'scannerPost:glareBlurY',
    layout: 'auto',
    compute: { module, entryPoint: 'glareBlurY' },
  });

  return {
    name: 'scannerPost:scan',
    writesTaps: [Tap.RGB_OUT],
    // Task 19b: port `scannerPostRadius` hulu (`SpektraVulkanRenderer.cpp:5005-5006`,
    // `printGlareBlurPath || scannerBlurPath || scannerUnsharpPath ?
    // kVulkanSpatialEffectRadiusPx : 0u`) -- ketiga dispatch glare DAN
    // kedua dispatch unsharp blur di tahap ini "SELALU berjalan" (lih.
    // blok komentar modul di atas), jadi guard hulu itu SELALU true di sini.
    //
    // Review seluruh-branch agenda #3: `glareGenerate`/`scanPreUnsharp`/`scan`
    // di bawah dispatch aktif-saja (`activeGroupsX/Y`) sementara
    // `glareBlurX/Y`/`unsharpBlurX/Y` dispatch full-buffer (`fullGroupsX/Y`)
    // -- mismatch yang SAMA dengan `grain.ts`. Diaudit dan DIUKUR (bukan
    // dinalar) pada skala apron produksi lewat `test/tiling.test.ts` ("Task
    // 19b -- gerbang bit-identik pada skala apron produksi"), yang memaksa
    // `remainingSpatialRadius` di titik tahap ini lebih kecil dari buffer
    // tile-nya sendiri (beda dari setiap fixture gerbang lain di repo ini).
    // Gerbang itu HIJAU untuk alasan struktural yang sama seperti `grain.ts`:
    // lih. komentar `grain.ts` di dekat `spatialRadiusPx`-nya untuk buktinya.
    // TIDAK diubah.
    spatialRadiusPx: SPATIAL_EFFECT_RADIUS_PX,
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const { width, height } = ctx.params;
      const floatBytes = width * height * FLOAT_BYTES;
      const glarePreBlur = ctx.scratch('scannerPost:glarePreBlur', floatBytes);
      const glareBlurXOut = ctx.scratch('scannerPost:glareBlurX', floatBytes);
      const glareBlurred = ctx.scratch('scannerPost:glareBlurred', floatBytes);

      // Fase 2C: amount unsharp dan mu glare per render (binding 12).
      const scannerFrame = ctx.device.createBuffer({
        label: 'scannerPost:frame',
        size: 16,
        usage: gpuBufferUsage.UNIFORM,
        mappedAtCreation: true,
      });
      new Float32Array(scannerFrame.getMappedRange()).set([
        ctx.frame.scannerUnsharpAmount ?? 0.7,
        glareLogMu(ctx.frame.glarePercent ?? 0.03),
        0,
        0,
      ]);
      scannerFrame.unmap();

      const activeWidth = ctx.params.activeWidth === 0 ? ctx.params.width : ctx.params.activeWidth;
      const activeHeight =
        ctx.params.activeHeight === 0 ? ctx.params.height : ctx.params.activeHeight;
      const activeGroupsX = Math.ceil(activeWidth / 32);
      const activeGroupsY = Math.ceil(activeHeight / 8);
      const fullGroupsX = Math.ceil(width / 32);
      const fullGroupsY = Math.ceil(height / 8);

      const glareGenerateBindGroup = ctx.device.createBindGroup({
        layout: glareGeneratePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 5, resource: { buffer: glarePreBlur } },
          { binding: 12, resource: { buffer: scannerFrame } },
        ],
      });
      const glareGeneratePass = encoder.beginComputePass({ label: 'scannerPost:glareGenerate' });
      glareGeneratePass.setPipeline(glareGeneratePipeline);
      glareGeneratePass.setBindGroup(0, glareGenerateBindGroup);
      glareGeneratePass.dispatchWorkgroups(activeGroupsX, activeGroupsY, 1);
      glareGeneratePass.end();

      const glareBlurXBindGroup = ctx.device.createBindGroup({
        layout: glareBlurXPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 5, resource: { buffer: glarePreBlur } },
          { binding: 6, resource: { buffer: glareBlurXOut } },
        ],
      });
      const glareBlurXPass = encoder.beginComputePass({ label: 'scannerPost:glareBlurX' });
      glareBlurXPass.setPipeline(glareBlurXPipeline);
      glareBlurXPass.setBindGroup(0, glareBlurXBindGroup);
      glareBlurXPass.dispatchWorkgroups(fullGroupsX, fullGroupsY, 1);
      glareBlurXPass.end();

      const glareBlurYBindGroup = ctx.device.createBindGroup({
        layout: glareBlurYPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 6, resource: { buffer: glareBlurXOut } },
          { binding: 7, resource: { buffer: glareBlurred } },
        ],
      });
      const glareBlurYPass = encoder.beginComputePass({ label: 'scannerPost:glareBlurY' });
      glareBlurYPass.setPipeline(glareBlurYPipeline);
      glareBlurYPass.setBindGroup(0, glareBlurYBindGroup);
      glareBlurYPass.dispatchWorkgroups(fullGroupsX, fullGroupsY, 1);
      glareBlurYPass.end();

      // Task 18c: `preUnsharp`/`unsharpBlurXOut`/`unsharpBlurred` -- vec4
      // penuh (BUKAN skalar seperti scratch glare di atas), PERSIS pola
      // `rawA`/`rawB`/dst `dir.ts`/`halation.ts`.
      const pixelBytes = width * height * 4 * FLOAT_BYTES;
      const preUnsharp = ctx.scratch('scannerPost:preUnsharp', pixelBytes);
      const unsharpBlurXOut = ctx.scratch('scannerPost:unsharpBlurXOut', pixelBytes);
      const unsharpBlurred = ctx.scratch('scannerPost:unsharpBlurred', pixelBytes);

      const kernelData = buildUnsharpKernelBuffer(UNSHARP_SIGMA_PX);
      const unsharpKernelBuffer = ctx.device.createBuffer({
        label: 'scannerPost:unsharpKernel',
        size: kernelData.byteLength,
        usage: gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(unsharpKernelBuffer.getMappedRange()).set(kernelData);
      unsharpKernelBuffer.unmap();

      const scanPreUnsharpBindGroup = ctx.device.createBindGroup({
        layout: scanPreUnsharpPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ctx.source } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 3, resource: { buffer: arenas.static.buffer } },
          { binding: 4, resource: { buffer: arenas.dynamic.buffer } },
          { binding: 7, resource: { buffer: glareBlurred } },
          { binding: 8, resource: { buffer: preUnsharp } },
        ],
      });
      const scanPreUnsharpPass = encoder.beginComputePass({ label: 'scannerPost:scanPreUnsharp' });
      scanPreUnsharpPass.setPipeline(scanPreUnsharpPipeline);
      scanPreUnsharpPass.setBindGroup(0, scanPreUnsharpBindGroup);
      scanPreUnsharpPass.dispatchWorkgroups(activeGroupsX, activeGroupsY, 1);
      scanPreUnsharpPass.end();

      const unsharpBlurXBindGroup = ctx.device.createBindGroup({
        layout: unsharpBlurXPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 8, resource: { buffer: preUnsharp } },
          { binding: 9, resource: { buffer: unsharpBlurXOut } },
          { binding: 11, resource: { buffer: unsharpKernelBuffer } },
        ],
      });
      // Kelompok dispatch PENUH (bukan aktif), PERSIS `glareBlurX`/`glareBlurY`
      // di atas -- pass blur butuh tetangga di luar wilayah aktif (lih.
      // catatan pola itu).
      const unsharpBlurXPass = encoder.beginComputePass({ label: 'scannerPost:unsharpBlurX' });
      unsharpBlurXPass.setPipeline(unsharpBlurXPipeline);
      unsharpBlurXPass.setBindGroup(0, unsharpBlurXBindGroup);
      unsharpBlurXPass.dispatchWorkgroups(fullGroupsX, fullGroupsY, 1);
      unsharpBlurXPass.end();

      const unsharpBlurYBindGroup = ctx.device.createBindGroup({
        layout: unsharpBlurYPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 9, resource: { buffer: unsharpBlurXOut } },
          { binding: 10, resource: { buffer: unsharpBlurred } },
          { binding: 11, resource: { buffer: unsharpKernelBuffer } },
        ],
      });
      const unsharpBlurYPass = encoder.beginComputePass({ label: 'scannerPost:unsharpBlurY' });
      unsharpBlurYPass.setPipeline(unsharpBlurYPipeline);
      unsharpBlurYPass.setBindGroup(0, unsharpBlurYBindGroup);
      unsharpBlurYPass.dispatchWorkgroups(fullGroupsX, fullGroupsY, 1);
      unsharpBlurYPass.end();

      const scanBindGroup = ctx.device.createBindGroup({
        layout: scanPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 1, resource: { buffer: ctx.dest } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 8, resource: { buffer: preUnsharp } },
          { binding: 10, resource: { buffer: unsharpBlurred } },
          { binding: 12, resource: { buffer: scannerFrame } },
        ],
      });
      const scanPass = encoder.beginComputePass({ label: 'scannerPost:scan' });
      scanPass.setPipeline(scanPipeline);
      scanPass.setBindGroup(0, scanBindGroup);
      scanPass.dispatchWorkgroups(activeGroupsX, activeGroupsY, 1);
      scanPass.end();
    },
  };
}
