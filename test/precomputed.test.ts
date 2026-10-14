// Constant colour tables saved between launches on iOS (host/precomputed.ts).
import { expect, it, vi } from 'vitest';

it('saved tables load back bit-identical, and a damaged file is ignored', async () => {
  const first = await import('../src/host/precomputed');
  const a = first.precomputed('test|f32', () => Float32Array.from({ length: 1001 }, (_, i) => Math.sin(i) * 1e-3));
  const b = first.precomputed('test|f64', () => Float64Array.from({ length: 333 }, (_, i) => Math.cos(i) / 7));
  expect(first.takePrecomputedChanged()).toBe(true);
  expect(first.takePrecomputedChanged()).toBe(false);
  const saved = first.serializePrecomputed();

  vi.resetModules();
  const next = await import('../src/host/precomputed');
  next.loadPrecomputed(new Uint8Array([1, 2, 3]).buffer);
  next.loadPrecomputed(saved);
  const rebuilt = vi.fn(() => new Float32Array(1));
  expect(Array.from(next.precomputed('test|f32', rebuilt))).toEqual(Array.from(a));
  expect(Array.from(next.precomputed('test|f64', () => new Float64Array(1)))).toEqual(Array.from(b));
  expect(rebuilt).not.toHaveBeenCalled();
  // Loading is not a change; nothing to save again.
  expect(next.takePrecomputedChanged()).toBe(false);
});
