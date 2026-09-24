import { CORE_PARAMS_WGSL } from '../params';
import { Tap } from '../taps';
import type { Stage, StageContext } from '../graph';
import type { Arenas } from '../arena';
import source from '../../shaders/scannerPost.wgsl?raw';

const FLOAT_BYTES = Float32Array.BYTES_PER_ELEMENT;

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
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const { width, height } = ctx.params;
      const floatBytes = width * height * FLOAT_BYTES;
      const glarePreBlur = ctx.scratch('scannerPost:glarePreBlur', floatBytes);
      const glareBlurXOut = ctx.scratch('scannerPost:glareBlurX', floatBytes);
      const glareBlurred = ctx.scratch('scannerPost:glareBlurred', floatBytes);

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

      const scanBindGroup = ctx.device.createBindGroup({
        layout: scanPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ctx.source } },
          { binding: 1, resource: { buffer: ctx.dest } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 3, resource: { buffer: arenas.static.buffer } },
          { binding: 4, resource: { buffer: arenas.dynamic.buffer } },
          { binding: 7, resource: { buffer: glareBlurred } },
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
