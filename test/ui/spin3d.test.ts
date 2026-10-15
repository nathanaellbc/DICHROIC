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

  it('dilepas berputar kencang -> berputar beberapa kali lalu kembali menghadap depan', () => {
    let q = IDENTITY, w: [number, number, number] = [14, 4, 2], travelled = 0;
    for (let t = 0; t < 8; t += 1 / 120) {
      ({ q, w } = settleStep(q, w, 1 / 120));
      travelled += Math.hypot(...w) / 120;
    }
    expect(travelled).toBeGreaterThan(2 * Math.PI); // paling sedikit satu putaran penuh
    expect(atRest(q, w)).toBe(true);
  });

  it('matrix3d identitas', () => {
    const v = cssMatrix(IDENTITY).slice(9, -1).split(',').map(Number);
    expect(v).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });
});
