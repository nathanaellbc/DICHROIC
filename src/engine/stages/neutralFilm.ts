import { CORE_PARAMS_WGSL } from '../params';
import { Tap } from '../taps';
import type { Stage } from '../graph';
import { gpuBufferUsage } from '../webgpuGlobals';
import type { Arenas } from '../arena';
import { midgrayDensityChannels, midgrayTablesFrom } from '../../host/printExposure';
import { frameBuffer } from '../transient';

/** Neutral negative: no stock colour/tone curve, with exposure/develop/texture retained. */
export function createNeutralFilmStage(device: GPUDevice, operation: 'expose' | 'develop' | 'scene', arenas?: Arenas): Stage {
  let anchor: number[] | undefined;
  const code = `${CORE_PARAMS_WGSL}
    @group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
    @group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
    @group(0) @binding(2) var<uniform> params: CoreParams;
    struct FilmFrame { row0: vec4<f32>, row1: vec4<f32>, row2: vec4<f32>, exposure: vec4<f32>, anchor: vec4<f32>, filters: vec4<f32>, flash: vec4<f32> }
    @group(0) @binding(3) var<uniform> frame: FilmFrame;
    const BLACK: f32 = 0.0107977516232771;
    fn cineon(v: vec3<f32>) -> vec3<f32> { return (vec3<f32>(685.0) + 300.0 * log(max(v, vec3<f32>(0.0)) * (1.0 - BLACK) + BLACK) / log(10.0)) / 1023.0; }
    fn inverse(code: vec3<f32>) -> vec3<f32> { return (pow(vec3<f32>(10.0), (code * 1023.0 - 685.0) / 300.0) - BLACK) / (1.0 - BLACK); }
    @compute @workgroup_size(32, 8)
    fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
      let x = gid.x + params.activeOriginX; let y = gid.y + params.activeOriginY;
      let w = select(params.activeWidth, params.width, params.activeWidth == 0u);
      let h = select(params.activeHeight, params.height, params.activeHeight == 0u);
      if (gid.x >= w || gid.y >= h || x >= params.width || y >= params.height) { return; }
      let i = y * params.width + x; let rgb = src[i].rgb;
      var result: vec3<f32>;
      ${operation === 'expose' ? `
        result = vec3<f32>(dot(frame.row0.xyz, rgb), dot(frame.row1.xyz, rgb), dot(frame.row2.xyz, rgb)) * frame.exposure.x;
      ` : operation === 'develop' ? `
        let linear = pow(vec3<f32>(10.0), rgb);
        let density = (cineon(linear) * 1023.0 - 95.0) / 500.0;
        let pivot = (cineon(vec3<f32>(0.18)) * 1023.0 - 95.0) / 500.0;
        result = max(vec3<f32>(0.0), pivot + (density - pivot) * frame.exposure.y);
      ` : `
        if (frame.exposure.w == 1.0) {
          // Stock negative density is balanced to its own neutral 18% patch.
          result = 0.18 * pow(vec3<f32>(10.0), frame.exposure.z * (rgb - frame.anchor.xyz) / 0.6);
        } else { result = inverse((rgb * 500.0 + 95.0) / 1023.0); }
        result = result * frame.anchor.w * frame.filters.xyz;
        let flashColor = vec3<f32>(1.0, pow(10.0, -frame.flash.x / 100.0), pow(10.0, -frame.flash.y / 100.0));
        result += frame.filters.w * 0.02 * flashColor;
      `}
      dst[i] = vec4<f32>(result, src[i].a);
    }`;
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code, label: `neutralFilm:${operation}` }), entryPoint: 'main' } });
  return {
    name: `neutralFilm:${operation}`,
    writesTaps: [operation === 'develop' ? Tap.CMY_FILM : Tap.RGB_PRE],
    encode(encoder, ctx) {
      if (!ctx.frame.neutralFilm) throw new Error('Missing neutral-film color transform.');
      const values = ctx.frame.neutralFilm.slice();
      if (operation === 'scene' && values[15] === 1) {
        if (!arenas) throw new Error('Negative LUT input requires film calibration.');
        anchor ??= midgrayDensityChannels(midgrayTablesFrom((arena, name) => arenas[arena].values(name), ctx.params.hanatosWidth, ctx.params.hanatosHeight), arenas.dynamic.values('printMidgrayColorSpace')[0]!);
        values.set(anchor, 16);
      }
      const buffer = frameBuffer(ctx, { size: 112, usage: gpuBufferUsage.UNIFORM, mappedAtCreation: true });
      new Float32Array(buffer.getMappedRange()).set(values); buffer.unmap();
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: ctx.source } }, { binding: 1, resource: { buffer: ctx.dest } },
        { binding: 2, resource: { buffer: ctx.paramsBuffer } }, { binding: 3, resource: { buffer } },
      ] });
      const pass = encoder.beginComputePass(); pass.setPipeline(pipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil((ctx.params.activeWidth || ctx.params.width) / 32), Math.ceil((ctx.params.activeHeight || ctx.params.height) / 8)); pass.end();
    },
  };
}
