import { CORE_PARAMS_WGSL } from '../params';
import { Tap } from '../taps';
import type { Stage, StageContext } from '../graph';
import type { Arenas } from '../arena';
import source from '../../shaders/curveDevelop.wgsl?raw';

/**
 * Tahap CurveDevelop (Task 12): transliterasi `SpektraCurveDevelop.comp`,
 * menulis tap `cmy_film` -- lih. peringatan struktural panjang di
 * `curveDevelop.wgsl` dan `test/parity/curveDevelop.test.ts`: tahap ini
 * sendirian TIDAK mereproduksi `cmy_film` Python secara lengkap (koreksi
 * coupler DIR ada di Task 13), hanya `develop_simple` (interpolasi kurva
 * densitas).
 *
 * Ikuti bentuk `createFilmExposureStage` (Task 11), tapi hanya konsumsi
 * arena `stock` (satu binding storage, bukan tiga) -- `curveExposure` dan
 * `densityCurves` keduanya dihitung/disalin ke arena itu di
 * `src/host/spectral.ts::precomputeArenaData`.
 */
export function createCurveDevelopStage(device: GPUDevice, arenas: Arenas): Stage {
  const arenaConstants = arenas.stock.wgslConstants();

  const module = device.createShaderModule({
    label: 'curveDevelop',
    code: `${CORE_PARAMS_WGSL}\n\n${arenaConstants}\n\n${source}`,
  });

  const pipeline = device.createComputePipeline({
    label: 'curveDevelop',
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  return {
    name: 'curveDevelop',
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

      // 0 berarti "seluruh buffer" -- sama seperti materializeActiveRegion
      // (Task 9) dan filmExposure (Task 11).
      const activeWidth = ctx.params.activeWidth === 0 ? ctx.params.width : ctx.params.activeWidth;
      const activeHeight =
        ctx.params.activeHeight === 0 ? ctx.params.height : ctx.params.activeHeight;

      const pass = encoder.beginComputePass({ label: 'curveDevelop' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(activeWidth / 32), Math.ceil(activeHeight / 8), 1);
      pass.end();
    },
  };
}
