import { CORE_PARAMS_WGSL } from '../params';
import { Tap } from '../taps';
import type { Stage } from '../graph';
import type { Arenas } from '../arena';
import { gpuBufferUsage } from '../webgpuGlobals';
import { directPaperAnchors } from '../../host/directPaper';
import source from '../../shaders/printScan.wgsl?raw';

/** Digital positive -> paper H&D curves -> existing spectral paper scanner. */
export function createDirectPaperStage(device: GPUDevice, arenas: Arenas): Stage {
  const anchors = directPaperAnchors(arenas);
  const extra = `
    struct DirectFrame { r0: vec4<f32>, r1: vec4<f32>, r2: vec4<f32>, anchor: vec4<f32>, direction: vec4<f32> }
    @group(0) @binding(6) var<uniform> direct: DirectFrame;
    @compute @workgroup_size(32, 8)
    fn directPaper(@builtin(global_invocation_id) gid: vec3<u32>) {
      if (gid.x >= params.width || gid.y >= params.height) { return; }
      let i = gid.y * params.width + gid.x;
      let pixel = src[i];
      let rgb = max(vec3<f32>(dot(direct.r0.xyz, pixel.rgb), dot(direct.r1.xyz, pixel.rgb), dot(direct.r2.xyz, pixel.rgb)), vec3<f32>(1e-6));
      let logExposure = direct.anchor.xyz + direct.direction.xyz * log(rgb / 0.184) * 0.4342944819032518 + direct.anchor.w;
      dst[i] = vec4<f32>(interpPrintDensityCurve(logExposure.r, 0u), interpPrintDensityCurve(logExposure.g, 1u), interpPrintDensityCurve(logExposure.b, 2u), pixel.a);
    }
  `;
  const module = device.createShaderModule({ label: 'directPaper', code: `${CORE_PARAMS_WGSL}\n${arenas.stock.wgslConstants()}\n${arenas.dynamic.wgslConstants()}\n${source}\n${extra}` });
  const pipeline = device.createComputePipeline({ label: 'directPaper', layout: 'auto', compute: { module, entryPoint: 'directPaper' } });
  return {
    name: 'directPaper', writesTaps: [Tap.CMY_PRINT],
    encode(encoder, ctx) {
      if (!ctx.frame.paperDirectMatrix) throw new Error('Direct paper requires input primaries.');
      const buffer = device.createBuffer({ size: 80, usage: gpuBufferUsage.UNIFORM, mappedAtCreation: true });
      const values = new Float32Array(buffer.getMappedRange());
      values.set(ctx.frame.paperDirectMatrix); values.set(anchors.subarray(0, 4), 12); values.set(anchors.subarray(4), 16);
      values[15] = Math.log10(ctx.frame.printExposure ?? 1);
      buffer.unmap();
      const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: ctx.source } }, { binding: 1, resource: { buffer: ctx.dest } },
        { binding: 2, resource: { buffer: ctx.paramsBuffer } }, { binding: 4, resource: { buffer: arenas.dynamic.buffer } },
        { binding: 6, resource: { buffer } },
      ] });
      const pass = encoder.beginComputePass({ label: 'directPaper' });
      pass.setPipeline(pipeline); pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(ctx.params.width / 32), Math.ceil(ctx.params.height / 8)); pass.end();
    },
  };
}
