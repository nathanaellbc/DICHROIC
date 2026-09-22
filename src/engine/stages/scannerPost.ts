import { CORE_PARAMS_WGSL } from '../params';
import { Tap } from '../taps';
import type { Stage, StageContext } from '../graph';
import type { Arenas } from '../arena';
import source from '../../shaders/scannerPost.wgsl?raw';

/**
 * Tahap ScannerPost (Task 18): satu entry point WGSL (`scan`), tap
 * `rgb_out` -- port `ScanningStage.scan()` Python
 * (`runtime/stages/scanning.py:46-50`). Ini tahap TERAKHIR pipeline;
 * setelahnya rantai selesai ujung ke ujung (lih. `test/parity/chain.ts`).
 *
 * Cakupan (gerbang `_lut`, satu-satunya yang berkas ini gerbangi
 * langsung) dan alasan lengkap tiap istilah yang TIDAK diimplementasikan
 * (glare, blur/unsharp, koreksi white/black) ada di blok komentar berkas
 * `scannerPost.wgsl`, bukan diulang di sini.
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

  const pipeline = device.createComputePipeline({
    label: 'scannerPost:scan',
    layout: 'auto',
    compute: { module, entryPoint: 'scan' },
  });

  return {
    name: 'scannerPost:scan',
    writesTaps: [Tap.RGB_OUT],
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const bindGroup = ctx.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ctx.source } },
          { binding: 1, resource: { buffer: ctx.dest } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 3, resource: { buffer: arenas.static.buffer } },
          { binding: 4, resource: { buffer: arenas.dynamic.buffer } },
        ],
      });

      const activeWidth = ctx.params.activeWidth === 0 ? ctx.params.width : ctx.params.activeWidth;
      const activeHeight =
        ctx.params.activeHeight === 0 ? ctx.params.height : ctx.params.activeHeight;

      const pass = encoder.beginComputePass({ label: 'scannerPost:scan' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(activeWidth / 32), Math.ceil(activeHeight / 8), 1);
      pass.end();
    },
  };
}
