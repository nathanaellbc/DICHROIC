import { describe, expect, it } from 'vitest';
import { IDENTITY, arcballDelta, arcballPoint, atRest, cssMatrix, fromAxisAngle, integrate, rotate, settleStep, toRotationVector } from '../../src/ui/components/spin3d';

const close = (a: number[], b: number[], eps = 1e-6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, -Math.log10(eps)));

describe('spin3d', () => {
  it('arcball membawa titik yang dipegang ke titik jari', () => {
    const a = arcballPoint(0.9, 0.1), b = arcballPoint(0.2, -0.5);
    close(rotate(arcballDelta(a, b), a), b);
  });

  it('menyusuri tepi = putar di bidang (sumbu z); menarik ke tengah = membalik (sumbu di bidang)', () => {
    const tangential = toRotationVector(arcballDelta(arcballPoint(1, 0), arcballPoint(0.995, 0.1)));
    expect(Math.abs(tangential[2])).toBeGreaterThan(Math.abs(tangential[0]) + Math.abs(tangential[1]));
    const radial = toRotationVector(arcballDelta(arcballPoint(1, 0), arcballPoint(0.6, 0)));
    expect(Math.abs(radial[1])).toBeGreaterThan(Math.abs(radial[0]) + Math.abs(radial[2]));
  });

  it('integrasi: 2 pi rad/s selama 0,25 s = seperempat putaran', () => {
    let q = IDENTITY;
    for (let i = 0; i < 100; i += 1) q = integrate(q, [0, 2 * Math.PI, 0], 0.0025);
    close(toRotationVector(q), toRotationVector(fromAxisAngle([0, 1, 0], Math.PI / 2)), 1e-4);
  });

  it('disentil (12 rad/s) -> sempat terbalik, lalu kembali menghadap depan tanpa membal keras', () => {
    let q = IDENTITY, w: [number, number, number] = [12, 0, 0], travelled = 0, maxAfter = 0, reached = false;
    for (let t = 0; t < 8; t += 1 / 120) {
      ({ q, w } = settleStep(q, w, 1 / 120));
      travelled += Math.hypot(...w) / 120;
      const angle = Math.hypot(...toRotationVector(q));
      if (reached) maxAfter = Math.max(maxAfter, angle);
      else if (t > 0.3 && angle < 0.05) reached = true;
    }
    expect(travelled).toBeGreaterThan(Math.PI); // paling sedikit setengah putaran (punggung terlihat)
    expect(maxAfter).toBeLessThan(0.35); // goyangan setelah kembali < 20 derajat
    expect(atRest(q, w)).toBe(true);
  });

  it('menuju orientasi target (melayang), bukan selalu datar', () => {
    const target = fromAxisAngle([1, 0.5, 0], 0.2);
    let q = IDENTITY, w: [number, number, number] = [0, 0, 0];
    for (let t = 0; t < 6; t += 1 / 120) ({ q, w } = settleStep(q, w, 1 / 120, target));
    close(toRotationVector(q), toRotationVector(target), 1e-3);
  });

  it('matrix3d identitas', () => {
    const v = cssMatrix(IDENTITY).slice(9, -1).split(',').map(Number);
    expect(v).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });
});
