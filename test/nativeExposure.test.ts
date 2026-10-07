import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { acquireDevice } from '../src/engine/device';
import { gpuBufferUsage, gpuMapMode } from '../src/engine/webgpuGlobals';

it('native exposure WGSL preserves neutral pixels and applies linear-light exposure', async () => {
  const { device } = await acquireDevice();
  const source = await readFile(new URL('../native/src/exposure.wgsl', import.meta.url), 'utf8');
  const module = device.createShaderModule({ code: source });
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const input = Uint8Array.from({ length: 256 * 4 }, (_, i) => i % 256);
  const buffers: GPUBuffer[] = [];
  const create = (size: number, usage: number) => {
    const b = device.createBuffer({ size, usage }); buffers.push(b); return b;
  };
  try {
    const src = create(input.length, gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_DST);
    const dst = create(input.length, gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_SRC);
    const control = create(16, gpuBufferUsage.UNIFORM | gpuBufferUsage.COPY_DST);
    const readback = create(input.length, gpuBufferUsage.MAP_READ | gpuBufferUsage.COPY_DST);
    device.queue.writeBuffer(src, 0, input);
    const group = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: src } }, { binding: 1, resource: { buffer: dst } }, { binding: 2, resource: { buffer: control } },
    ] });
    for (const ev of [0, 1, -2]) {
      const uniforms = new ArrayBuffer(16);
      new Uint32Array(uniforms)[0] = 256;
      new Float32Array(uniforms)[1] = ev;
      device.queue.writeBuffer(control, 0, uniforms);
      const commands = device.createCommandEncoder();
      const pass = commands.beginComputePass();
      pass.setPipeline(pipeline); pass.setBindGroup(0, group); pass.dispatchWorkgroups(1); pass.end();
      commands.copyBufferToBuffer(dst, 0, readback, 0, input.length);
      device.queue.submit([commands.finish()]);
      await readback.mapAsync(gpuMapMode.READ);
      const pixels = new Uint8Array(readback.getMappedRange()).slice();
      readback.unmap();
      for (let i = 0; i < input.length; i++) {
        if (i % 4 === 3) { expect(pixels[i]).toBe(input[i]); continue; }
        const v = input[i]! / 255;
        const linear = (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * 2 ** ev;
        const c = Math.max(0, Math.min(1, linear));
        const q = Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
        expect(Math.abs(pixels[i]! - q)).toBeLessThanOrEqual(1);
      }
    }
  } finally { for (const buffer of buffers) buffer.destroy(); }
});
