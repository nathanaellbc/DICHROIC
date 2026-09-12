import { describe, it, expect } from 'vitest';
import { acquireDevice } from '../src/engine/device';

describe('acquireDevice', () => {
  it('memperoleh device dengan limit yang dilaporkan', async () => {
    const engine = await acquireDevice();
    expect(engine.device).toBeDefined();
    expect(engine.maxStorageBufferBindingSize).toBeGreaterThan(0);
  });

  it('menyediakan minimal 8 storage buffer per stage', async () => {
    const engine = await acquireDevice();
    expect(engine.limits.maxStorageBuffersPerShaderStage).toBeGreaterThanOrEqual(8);
  });
});
