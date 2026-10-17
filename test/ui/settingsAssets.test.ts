import { describe, expect, it } from 'vitest';
import { formatBytes, modelAssets } from '../../src/ui/settings/assets';
import { DEPTH_MODELS, MATTE_MODEL, MATTE_URL, RUNTIME_BYTES } from '../../src/depth/model';

describe('Settings: model assets', () => {
  const desktop = { backend: 'webgpu' as const, inputSize: 770, guideMaxEdge: 2048, lowMemory: false, gpuF16: true };

  it('lists each available depth model plus ViTMatte, with the runtime for its backend', () => {
    const assets = modelAssets(desktop, ['fast', 'detail']);
    expect(assets.map((a) => a.id)).toEqual(['fast', 'detail', 'matte']);
    const fast = assets[0]!;
    expect(fast.label).toBe(DEPTH_MODELS.fast.label);
    expect(fast.files).toHaveLength(1);
    expect(fast.files[0]!.url).toContain(DEPTH_MODELS.fast.repo);
    expect(fast.runtime.bytes).toBe(RUNTIME_BYTES.webgpu);
    const matte = assets[2]!;
    expect(matte.files).toEqual([{ url: MATTE_URL, bytes: MATTE_MODEL.bytes }]);
  });

  it('split models (Depth Pro) download every part', () => {
    const pro = modelAssets(desktop, ['pro'])[0]!;
    expect(pro.files.length).toBe(3);
  });

  it('formats sizes like the rest of the app', () => {
    expect(formatBytes(49_642_442)).toBe('50 MB');
    expect(formatBytes(426_248_540)).toBe('426 MB');
    expect(formatBytes(1_400_000_000)).toBe('1.4 GB');
  });
});
