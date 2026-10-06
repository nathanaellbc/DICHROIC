import { CORE_PARAMS_WGSL } from '../params';
import { Tap } from '../taps';
import type { Stage } from '../graph';
import type { PrintCube } from '../../profiles/printLuts';
import { gpuBufferUsage } from '../webgpuGlobals';
import { frameBuffer } from '../transient';

/** Rec.709 linear -> Cineon -> tetrahedral LUT -> gamma 2.4 decode -> output primaries. */
export function createPrintLutStage(device: GPUDevice, cube: PrintCube): Stage {
  const code = `${CORE_PARAMS_WGSL}
    @group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
    @group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
    @group(0) @binding(2) var<uniform> params: CoreParams;
    @group(0) @binding(3) var<storage, read> cube: array<vec4<f32>>;
    struct Transform { row0: vec4<f32>, row1: vec4<f32>, row2: vec4<f32>, encoding: vec4<f32> }
    @group(0) @binding(4) var<uniform> frame: Transform;
    const N: u32 = ${cube.size}u;
    fn sample(p: vec3<u32>) -> vec3<f32> { return cube[p.x + N * (p.y + N * p.z)].rgb; }
    fn tetra(rgb: vec3<f32>) -> vec3<f32> {
      let p = clamp(rgb, vec3<f32>(0.0), vec3<f32>(1.0)) * f32(N - 1u);
      let base = min(vec3<u32>(floor(p)), vec3<u32>(N - 2u)); let f = p - vec3<f32>(base);
      var a = vec3<u32>(0u); var c = vec3<u32>(0u);
      if (f.x >= f.y && f.x >= f.z) { a.x = 1u; } else if (f.y >= f.z) { a.y = 1u; } else { a.z = 1u; }
      if (f.z <= f.x && f.z <= f.y) { c.z = 1u; } else if (f.y <= f.x) { c.y = 1u; } else { c.x = 1u; }
      let high = max(f.x, max(f.y, f.z)); let low = min(f.x, min(f.y, f.z)); let mid = f.x + f.y + f.z - high - low;
      return (1.0 - high) * sample(base) + (high - mid) * sample(base + a) + (mid - low) * sample(base + vec3<u32>(1u) - c) + low * sample(base + vec3<u32>(1u));
    }
    @compute @workgroup_size(32, 8)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let x = gid.x + params.activeOriginX; let y = gid.y + params.activeOriginY;
      let w = select(params.activeWidth, params.width, params.activeWidth == 0u); let h = select(params.activeHeight, params.height, params.activeHeight == 0u);
      if (gid.x >= w || gid.y >= h || x >= params.width || y >= params.height) { return; }
      let i = y * params.width + x;
      let linear = max(src[i].rgb, vec3<f32>(0.0));
      let cineon = (vec3<f32>(685.0) + 300.0 * log(linear * (1.0 - 0.0107977516232771) + 0.0107977516232771) / log(10.0)) / 1023.0;
      let lutLinear = pow(max(tetra(cineon), vec3<f32>(0.0)), vec3<f32>(2.4));
      dst[i] = vec4<f32>(dot(frame.row0.xyz, lutLinear), dot(frame.row1.xyz, lutLinear), dot(frame.row2.xyz, lutLinear), src[i].a);
    }`;
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code, label: 'printLut:Cineon' }), entryPoint: 'main' } });
  const lut = device.createBuffer({ size: cube.rgba.byteLength, usage: gpuBufferUsage.STORAGE, mappedAtCreation: true });
  new Float32Array(lut.getMappedRange()).set(cube.rgba); lut.unmap();
  return {
    name: 'printLut:Cineon', writesTaps: [Tap.RGB_PRE], dispose: () => lut.destroy(),
    encode(encoder, ctx) {
      if (!ctx.frame.cameraOutput) throw new Error('Missing LUT output primaries transform.');
      const transform = frameBuffer(ctx, { size: 64, usage: gpuBufferUsage.UNIFORM, mappedAtCreation: true });
      new Float32Array(transform.getMappedRange()).set(ctx.frame.cameraOutput); transform.unmap();
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: ctx.source } }, { binding: 1, resource: { buffer: ctx.dest } },
        { binding: 2, resource: { buffer: ctx.paramsBuffer } }, { binding: 3, resource: { buffer: lut } }, { binding: 4, resource: { buffer: transform } },
      ] });
      const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil((ctx.params.activeWidth || ctx.params.width) / 32), Math.ceil((ctx.params.activeHeight || ctx.params.height) / 8)); pass.end();
    },
  };
}
