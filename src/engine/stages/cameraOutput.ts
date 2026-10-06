import { CORE_PARAMS_WGSL } from '../params';
import { Tap } from '../taps';
import type { Stage } from '../graph';
import { gpuBufferUsage } from '../webgpuGlobals';
import { frameBuffer } from '../transient';

/** Finish the film bypass in selected output primaries and transfer function. */
export function createCameraOutputStage(device: GPUDevice): Stage {
  const module = device.createShaderModule({ label: 'cameraOutput', code: `${CORE_PARAMS_WGSL}
    @group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
    @group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
    @group(0) @binding(2) var<uniform> params: CoreParams;
    struct OutputFrame { row0: vec4<f32>, row1: vec4<f32>, row2: vec4<f32>, encoding: vec4<f32> }
    @group(0) @binding(3) var<uniform> frame: OutputFrame;
    fn signedPow(v: f32, p: f32) -> f32 { return sign(v) * pow(abs(v), p); }
    fn encode(v: f32) -> f32 {
      if (frame.encoding.x == 1.0) {
        if (v <= 0.0031308) { return v * 12.92; }
        return 1.055 * pow(v, 1.0 / 2.4) - 0.055;
      }
      if (frame.encoding.x == 2.0) {
        if (v < 1.0 / 512.0) { return 16.0 * v; }
        return signedPow(v, 1.0 / 1.8);
      }
      if (frame.encoding.x == 3.0) { return signedPow(v, 1.0 / frame.encoding.y); }
      return v;
    }
    @compute @workgroup_size(32, 8)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      if (gid.x >= params.width || gid.y >= params.height) { return; }
      let i = gid.y * params.width + gid.x;
      let rgb = src[i].rgb;
      let converted = vec3<f32>(dot(frame.row0.xyz, rgb), dot(frame.row1.xyz, rgb), dot(frame.row2.xyz, rgb));
      dst[i] = vec4<f32>(encode(converted.r), encode(converted.g), encode(converted.b), src[i].a);
    }
  ` });
  const pipeline = device.createComputePipeline({ label: 'cameraOutput', layout: 'auto', compute: { module, entryPoint: 'main' } });
  return {
    name: 'cameraOutput', writesTaps: [Tap.RGB_OUT],
    encode(encoder, ctx) {
      if (!ctx.frame.cameraOutput) throw new Error('Film bypass requires an output color transform.');
      const frame = frameBuffer(ctx, { size: 64, usage: gpuBufferUsage.UNIFORM, mappedAtCreation: true });
      new Float32Array(frame.getMappedRange()).set(ctx.frame.cameraOutput);
      frame.unmap();
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: ctx.source } }, { binding: 1, resource: { buffer: ctx.dest } },
        { binding: 2, resource: { buffer: ctx.paramsBuffer } }, { binding: 3, resource: { buffer: frame } },
      ] });
      const pass = encoder.beginComputePass({ label: 'cameraOutput' });
      pass.setPipeline(pipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(ctx.params.width / 32), Math.ceil(ctx.params.height / 8)); pass.end();
    },
  };
}
