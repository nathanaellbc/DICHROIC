import { describe, it, expect } from 'vitest';
import { acquireDevice } from '../../src/engine/device';
import { SELF_TEST_TOLERANCE, compareSelfTest, runPrecisionSelfTest } from '../../src/engine/precisionSelfTest';

describe('self-test presisi IIR (df64)', () => {
  it('lulus di device ini dengan galat di level pembulatan f32', async () => {
    const { device } = await acquireDevice();
    const result = await runPrecisionSelfTest(device);
    expect(result.ok).toBe(true);
    expect(result.maxAbsError).toBeLessThanOrEqual(1e-6);
  });

  it('menandai gagal bila GPU menyimpang dari referensi f64 melebihi ambang', () => {
    // Galat khas df64 yang runtuh ke f32 polos (terukur 1e-4..1.6e-3, Fase 2A.5 Task 2).
    const cpu = Float64Array.of(0.5, 0.25, 0.125);
    expect(compareSelfTest(Float32Array.of(0.5, 0.25, 0.125 + 2e-4), cpu)).toEqual({ ok: false, maxAbsError: expect.closeTo(2e-4, 6) });
    expect(compareSelfTest(Float32Array.of(0.5, 0.25, 0.125), cpu).ok).toBe(true);
    expect(SELF_TEST_TOLERANCE).toBe(1e-5);
  });
});
