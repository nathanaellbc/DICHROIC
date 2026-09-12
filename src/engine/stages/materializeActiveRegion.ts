import { CORE_PARAMS_WGSL } from '../params';
import { Tap } from '../taps';
import type { Stage, StageContext } from '../graph';
import source from '../../shaders/materializeActiveRegion.wgsl?raw';

/**
 * Tahap pertama dalam graf: materialisasi region aktif ke tap `rgb_in`.
 * Lih. komentar di `materializeActiveRegion.wgsl` untuk kenapa primitif ini
 * ada (dan kenapa dua shader hulu — Copy dan FormatConvert — tidak diport).
 */
export function createMaterializeActiveRegionStage(device: GPUDevice): Stage {
  const module = device.createShaderModule({
    label: 'materializeActiveRegion',
    code: `${CORE_PARAMS_WGSL}\n\n${source}`,
  });

  const pipeline = device.createComputePipeline({
    label: 'materializeActiveRegion',
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  return {
    name: 'materializeActiveRegion',
    writesTaps: [Tap.RGB_IN],
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const bindGroup = ctx.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ctx.source } },
          { binding: 1, resource: { buffer: ctx.dest } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
        ],
      });
      const pass = encoder.beginComputePass({ label: 'materializeActiveRegion' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(ctx.params.activeWidth / 32),
        Math.ceil(ctx.params.activeHeight / 8),
        1,
      );
      pass.end();
    },
  };
}
