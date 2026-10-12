import { gpuBufferUsage } from '../webgpuGlobals';
import { Tap } from '../taps';
import type { Stage } from '../graph';
import { NATURAL_STRENGTH } from '../../host/naturalize';
import source from '../../shaders/natural.wgsl?raw';
import { frameBuffer } from '../transient';

/**
 * Tahap "Natural" (`host/naturalize.ts`): membalik gaya ISP HP pada input
 * ter-encode, sebelum filmExposure. Per piksel; peta kontras kasar dibaca
 * dengan posisi absolut, jadi render ter-tile tanpa sambungan dan tanpa apron.
 */
export function createNaturalStage(device: GPUDevice): Stage {
  const module = device.createShaderModule({ label: 'natural', code: source });
  const pipeline = device.createComputePipeline({ label: 'natural', layout: 'auto', compute: { module, entryPoint: 'main' } });
  return {
    name: 'natural',
    writesTaps: [Tap.RGB_PRE],
    spatialRadiusPx: 0,
    encode(encoder, ctx) {
      const nat = ctx.frame.natural;
      if (!nat) throw new Error('natural: FrameParams tidak membawa setelan Natural.');
      const { width, height, fullWidth, fullHeight, tileOriginX, tileOriginY } = ctx.params;
      const S = NATURAL_STRENGTH;
      const settings = frameBuffer(ctx, { label: 'natural:settings', size: 96, usage: gpuBufferUsage.UNIFORM, mappedAtCreation: true });
      const mapped = settings.getMappedRange();
      new Uint32Array(mapped).set([width, height, fullWidth, fullHeight, tileOriginX, tileOriginY, nat.grid.width, nat.grid.height]);
      new Float32Array(mapped).set([
        nat.amount, nat.logMean, nat.lutMin, nat.lutMax,
        nat.luma[0], nat.luma[1], nat.luma[2], nat.lut.length,
        S.tone, S.local, S.highlight, S.vibrance,
        S.clipDesaturate, S.noise, nat.gain, S.vibranceKnee,
      ], 8);
      settings.unmap();
      const upload = (label: string, data: Float32Array) => {
        const buffer = frameBuffer(ctx, { label, size: Math.max(data.byteLength, 16), usage: gpuBufferUsage.STORAGE, mappedAtCreation: true });
        new Float32Array(buffer.getMappedRange()).set(data);
        buffer.unmap();
        return buffer;
      };
      const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ctx.source } },
          { binding: 1, resource: { buffer: ctx.dest } },
          { binding: 2, resource: { buffer: upload('natural:lut', nat.lut) } },
          { binding: 3, resource: { buffer: upload('natural:grid', nat.grid.data) } },
          { binding: 4, resource: { buffer: settings } },
        ],
      });
      const pass = encoder.beginComputePass({ label: 'natural' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 8));
      pass.end();
    },
  };
}
