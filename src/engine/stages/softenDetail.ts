import { softenKernel } from '../../host/softenDetail';
import { gpuBufferUsage } from '../webgpuGlobals';
import { Tap } from '../taps';
import type { Stage } from '../graph';
import source from '../../shaders/softenDetail.wgsl?raw';

export function createSoftenDetailStage(device: GPUDevice): Stage {
  const module = device.createShaderModule({ label: 'softenDetail', code: source });
  const bindings = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } },
    ...[1, 2, 3].map((binding) => ({ binding, visibility: 4, buffer: { type: 'storage' as const } })),
    { binding: 4, visibility: 4, buffer: { type: 'uniform' } },
  ] });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bindings] });
  const pipelines = ['momentsX', 'coefficientsY', 'coefficientsX', 'combineY'].map((entryPoint) => device.createComputePipeline({ label: `softenDetail:${entryPoint}`, layout, compute: { module, entryPoint } }));
  return {
    name: 'softenDetail', writesTaps: [Tap.RGB_PRE],
    spatialRadiusPx: (params) => 2 * softenKernel(Math.max(params.fullWidth, params.fullHeight)).radius,
    encode(encoder, ctx) {
      const { width, height, fullWidth, fullHeight } = ctx.params;
      const { sigma, radius } = softenKernel(Math.max(fullWidth, fullHeight));
      const settings = ctx.device.createBuffer({ label: 'softenDetail:settings', size: 48, usage: gpuBufferUsage.UNIFORM, mappedAtCreation: true });
      const mapped = settings.getMappedRange();
      new Uint32Array(mapped).set([width, height, radius, 0]);
      new Float32Array(mapped).set([ctx.frame.softenDetail?.amount ?? 0, sigma, 0, 0, ...(ctx.frame.softenDetail?.luma ?? [0.2126, 0.7152, 0.0722]), 0], 4);
      settings.unmap();
      const group = device.createBindGroup({ layout: bindings, entries: [
        { binding: 0, resource: { buffer: ctx.source } }, { binding: 1, resource: { buffer: ctx.dest } },
        { binding: 2, resource: { buffer: ctx.scratch('softenDetail:a', width * height * 8) } },
        { binding: 3, resource: { buffer: ctx.scratch('softenDetail:b', width * height * 8) } },
        { binding: 4, resource: { buffer: settings } },
      ] });
      for (const pipeline of pipelines) { const pass = encoder.beginComputePass({ label: 'softenDetail' }); pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 8)); pass.end(); }
      // The graph submits synchronously after encode; release the transient
      // uniform after submission. Scratch buffers remain owned by the pool.
      queueMicrotask(() => settings.destroy());
    },
  };
}
