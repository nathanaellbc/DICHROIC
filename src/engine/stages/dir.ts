import { CORE_PARAMS_WGSL } from '../params';
import { Tap } from '../taps';
import type { Stage, StageContext } from '../graph';
import type { Arenas } from '../arena';
import source from '../../shaders/dir.wgsl?raw';

/**
 * Tahap Dir (Task 13): transliterasi PARSIAL `SpektraDir.comp` (kOpCorrection
 * FromDensity + kOpRedevelop, digabung satu dispatch karena difusi spasial
 * mati di bawah `lut_mode` -- lih. catatan cakupan panjang di `dir.wgsl`).
 * Menutup gerbang `cmy_film` yang Task 12 sengaja tinggalkan gagal
 * (`curveDevelop.wgsl` mengimplementasikan `develop_simple` Python,
 * `dir.wgsl` menambahkan `apply_density_correction_dir_couplers`; bersama
 * keduanya mereproduksi `model/develop.py::develop()` LENGKAP untuk keluarga
 * `_lut`, di mana grain juga mati).
 *
 * Ikuti bentuk `createCurveDevelopStage` (Task 12) persis, TERMASUK
 * `writesTaps = [Tap.CMY_FILM]` -- tahap ini juga menyempurnakan tap yang
 * sama, bukan tap baru (lih. dokumentasi `RenderGraph`/`findLastStageIndex`
 * di `graph.ts`: pencarian tahap TERAKHIR yang menulis tap yang diminta
 * memastikan `dir` yang dipilih, bukan `curveDevelop`, saat keduanya
 * terdaftar berurutan pada graf yang sama).
 *
 * WAJIB terdaftar tepat SETELAH `createCurveDevelopStage` pada
 * `RenderGraph` yang sama -- lih. catatan pengikatan buffer di `dir.wgsl`
 * untuk alasan invarian ping-pong ini bukan kebetulan.
 */
export function createDirStage(device: GPUDevice, arenas: Arenas): Stage {
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

  return {
    name: 'dir',
    writesTaps: [Tap.CMY_FILM],
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const bindGroup = ctx.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ctx.source } },
          { binding: 1, resource: { buffer: ctx.dest } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 3, resource: { buffer: arenas.stock.buffer } },
        ],
      });

      // 0 berarti "seluruh buffer" -- sama seperti curveDevelop (Task 12).
      const activeWidth = ctx.params.activeWidth === 0 ? ctx.params.width : ctx.params.activeWidth;
      const activeHeight =
        ctx.params.activeHeight === 0 ? ctx.params.height : ctx.params.activeHeight;

      const pass = encoder.beginComputePass({ label: 'dir' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(activeWidth / 32), Math.ceil(activeHeight / 8), 1);
      pass.end();
    },
  };
}
