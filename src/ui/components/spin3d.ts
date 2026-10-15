/**
 * Rotasi 3D stiker (kuaternion), di ruang layar CSS: x ke kanan, y ke bawah,
 * z ke arah penonton. Semua rumus memakai hasil kali silang biasa secara
 * konsisten, jadi rotasi memetakan vektor apa adanya di ruang itu (tanpa
 * perlu memikirkan kiri/kanan sistem koordinat CSS).
 *
 *  - arcball: titik yang dipegang di bola maya mengikuti jari -> putaran x, y, z
 *    (menyusuri tepi = putar di bidang, menarik ke/dari tengah = membalik);
 *  - inersia: kecepatan sudut berlanjut setelah dilepas, lalu pegas kurang
 *    teredam membawa muka kembali menghadap depan.
 */

/** [w, x, y, z] */
export type Quat = [number, number, number, number];
export type Vec3 = [number, number, number];

export const IDENTITY: Quat = [1, 0, 0, 0];

export function qmul(a: Quat, b: Quat): Quat {
  const [aw, ax, ay, az] = a, [bw, bx, by, bz] = b;
  return [
    aw * bw - ax * bx - ay * by - az * bz,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
  ];
}

export function qnorm(q: Quat): Quat {
  const n = Math.hypot(...q) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function qconj(q: Quat): Quat {
  return [q[0], -q[1], -q[2], -q[3]];
}

export function fromAxisAngle(axis: Vec3, angle: number): Quat {
  const n = Math.hypot(...axis);
  if (n < 1e-9 || Math.abs(angle) < 1e-9) return IDENTITY;
  const s = Math.sin(angle / 2) / n;
  return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}

/** Rotasi sebagai vektor sumbu x sudut (rad), jalur terpendek. */
export function toRotationVector(q: Quat): Vec3 {
  const p = q[0] < 0 ? ([-q[0], -q[1], -q[2], -q[3]] as Quat) : q;
  const s = Math.hypot(p[1], p[2], p[3]);
  if (s < 1e-9) return [0, 0, 0];
  const angle = 2 * Math.atan2(s, p[0]);
  return [(p[1] / s) * angle, (p[2] / s) * angle, (p[3] / s) * angle];
}

/** Rotasi vektor v oleh q. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const r = qmul(qmul(q, [0, v[0], v[1], v[2]]), qconj(q));
  return [r[1], r[2], r[3]];
}

/** Matriks 3x3 baris-mayor: kolom = sumbu x, y, z yang diputar. */
export function toMatrix(q: Quat): number[] {
  const x = rotate(q, [1, 0, 0]), y = rotate(q, [0, 1, 0]), z = rotate(q, [0, 0, 1]);
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

/** `matrix3d(...)` CSS (kolom-mayor) untuk rotasi q. */
export function cssMatrix(q: Quat): string {
  const m = toMatrix(q);
  const v = [m[0], m[3], m[6], 0, m[1], m[4], m[7], 0, m[2], m[5], m[8], 0, 0, 0, 0, 1];
  return `matrix3d(${v.map((n) => (Math.abs(n!) < 1e-7 ? 0 : n!.toFixed(6))).join(',')})`;
}

/** Titik di bola maya berjari-jari 1 untuk offset (dx, dy) / jari-jari; di luar bola: di tepinya. */
export function arcballPoint(dx: number, dy: number): Vec3 {
  const d2 = dx * dx + dy * dy;
  if (d2 <= 1) return [dx, dy, Math.sqrt(1 - d2)];
  const d = Math.sqrt(d2);
  return [dx / d, dy / d, 0];
}

/** Rotasi yang membawa titik bola a ke b (rumus Rodrigues lewat kuaternion). */
export function arcballDelta(a: Vec3, b: Vec3): Quat {
  const axis: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return fromAxisAngle(axis, Math.acos(dot));
}

/** Integrasi satu langkah: kecepatan sudut w (rad/s, ruang layar) memutar q. */
export function integrate(q: Quat, w: Vec3, dt: number): Quat {
  const speed = Math.hypot(...w);
  if (speed < 1e-6) return q;
  return qnorm(qmul(fromAxisAngle(w, speed * dt), q));
}

/**
 * Langkah bebas setelah dilepas, menuju orientasi `target` (muka depan, atau
 * kemiringan melayang). Selagi berputar kencang, pegas melemah
 * (k / (1 + (|w| / 4)^2)) dan hanya gesekan ringan yang bekerja -- sentilan
 * masih berputar; setelah melambat pegas yang cukup teredam (zeta 0,6)
 * membawanya kembali dengan goyangan kecil, tidak membal keras.
 */
export function settleStep(q: Quat, w: Vec3, dt: number, target: Quat = IDENTITY, stiffness = 16, zeta = 0.6, drag = 0.6): { q: Quat; w: Vec3 } {
  const e = toRotationVector(qmul(q, qconj(target)));
  const speed = Math.hypot(...w);
  const k = stiffness / (1 + (speed / 4) ** 2);
  const c = 2 * Math.sqrt(k) * zeta + drag;
  const nw: Vec3 = [
    w[0] + (-e[0] * k - w[0] * c) * dt,
    w[1] + (-e[1] * k - w[1] * c) * dt,
    w[2] + (-e[2] * k - w[2] * c) * dt,
  ];
  return { q: integrate(q, nw, dt), w: nw };
}

/** Kecepatan sudut dari dua orientasi berurutan. */
export function angularVelocity(prev: Quat, next: Quat, dt: number): Vec3 {
  const r = toRotationVector(qmul(next, qconj(prev)));
  return [r[0] / dt, r[1] / dt, r[2] / dt];
}

/** Hampir menghadap depan dan diam. */
export function atRest(q: Quat, w: Vec3): boolean {
  return Math.hypot(...toRotationVector(q)) < 0.002 && Math.hypot(...w) < 0.01;
}
