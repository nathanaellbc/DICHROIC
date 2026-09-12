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
      // 0 berarti "seluruh buffer" (lih. dokumentasi CoreParams di params.ts
      // dan penjaga 1 di materializeActiveRegion.wgsl) — dispatch harus
      // menutupi ukuran EFEKTIF, bukan literal 0 (yang berarti nol invokasi).
      const activeWidth = ctx.params.activeWidth === 0 ? ctx.params.width : ctx.params.activeWidth;
      const activeHeight =
        ctx.params.activeHeight === 0 ? ctx.params.height : ctx.params.activeHeight;

      const pass = encoder.beginComputePass({ label: 'materializeActiveRegion' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(activeWidth / 32), Math.ceil(activeHeight / 8), 1);
      pass.end();
    },
  };
}
