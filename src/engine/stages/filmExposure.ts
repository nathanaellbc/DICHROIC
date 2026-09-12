import { CORE_PARAMS_WGSL } from '../params';
import { Tap } from '../taps';
import type { Stage, StageContext } from '../graph';
import type { Arenas } from '../arena';
import source from '../../shaders/filmExposure.wgsl?raw';

/**
 * Tahap FilmExposure (Task 11): transliterasi `SpektraFilmExposure.comp`,
 * menulis tap `log_e_film`. Lih. `filmExposure.wgsl` untuk penjelasan
 * arena/konvensi matriks, dan `src/host/spectral.ts` untuk bagaimana
 * `arenas` (Task 8) diisi dari `AssetBundle` (Task 5).
 *
 * Ikuti bentuk `createMaterializeActiveRegionStage` (Task 9): modul shader
 * dengan `CORE_PARAMS_WGSL` + konstanta arena disambung di depan, pipeline
 * dibuat sekali, `encode()` membangun bind group per dispatch (arena tidak
 * berubah antar dispatch, tapi `ctx.source`/`ctx.dest` berganti tiap tahap
 * lewat ping-pong `RenderGraph`).
 */
export function createFilmExposureStage(device: GPUDevice, arenas: Arenas): Stage {
  const arenaConstants = [
    arenas.static.wgslConstants(),
    arenas.stock.wgslConstants(),
    arenas.dynamic.wgslConstants(),
  ].join('\n');

  const module = device.createShaderModule({
    label: 'filmExposure',
    code: `${CORE_PARAMS_WGSL}\n\n${arenaConstants}\n\n${source}`,
  });

  const pipeline = device.createComputePipeline({
    label: 'filmExposure',
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  return {
    name: 'filmExposure',
    writesTaps: [Tap.LOG_E_FILM],
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const bindGroup = ctx.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ctx.source } },
          { binding: 1, resource: { buffer: ctx.dest } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 3, resource: { buffer: arenas.static.buffer } },
          { binding: 4, resource: { buffer: arenas.stock.buffer } },
          { binding: 5, resource: { buffer: arenas.dynamic.buffer } },
        ],
      });

      // 0 berarti "seluruh buffer" -- sama seperti materializeActiveRegion
      // (Task 9), lih. dokumentasi CoreParams di params.ts.
      const activeWidth = ctx.params.activeWidth === 0 ? ctx.params.width : ctx.params.activeWidth;
      const activeHeight =
        ctx.params.activeHeight === 0 ? ctx.params.height : ctx.params.activeHeight;

      const pass = encoder.beginComputePass({ label: 'filmExposure' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(activeWidth / 32), Math.ceil(activeHeight / 8), 1);
      pass.end();
    },
  };
}
