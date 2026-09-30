import { describe, expect, it, vi } from 'vitest';
import { RenderGraph } from '../src/engine/graph';
import { Tap } from '../src/engine/taps';
import type { EngineDevice } from '../src/engine/device';
import type { CoreParams } from '../src/engine/params';

describe('graph failure cleanup', () => {
  it.each(['allocation', 'encode', 'readback'])('releases every transient buffer after %s fails', async (failure) => {
    const buffers: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
    const device = {
      queue: { writeBuffer: vi.fn(), submit: vi.fn() },
      createBuffer: () => {
        if (failure === 'allocation' && buffers.length === 1) throw new Error('allocation failed');
        const buffer = { destroy: vi.fn(), mapAsync: async () => { throw new Error('readback failed'); } };
        buffers.push(buffer); return buffer;
      },
      createCommandEncoder: () => ({ copyBufferToBuffer: vi.fn(), finish: vi.fn() }),
    };
    const graph = new RenderGraph({ device, maxStorageBufferBindingSize: 1024 } as unknown as EngineDevice);
    graph.addStage({ name: 'test', writesTaps: [Tap.RGB_OUT], encode: () => {
      if (failure === 'encode') throw new Error('encode failed');
    } });
    const params = { width: 1, height: 1, activeOriginX: 0, activeOriginY: 0, activeWidth: 1, activeHeight: 1 } as CoreParams;
    await expect(graph.run(new Float32Array(4), params, Tap.RGB_OUT)).rejects.toThrow(`${failure} failed`);
    expect(buffers.length).toBeGreaterThan(0);
    for (const buffer of buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    graph.dispose();
  });
});
