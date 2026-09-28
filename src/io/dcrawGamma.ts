/**
 * Kurva gamma dcraw/LibRaw dan inversnya (rencana 2B Task 5).
 *
 * `libraw-wasm` 1.6.0 mengabaikan `gamm` dalam semua bentuk, jadi keluaran
 * 16-bit-nya selalu melewati kurva bawaan LibRaw: `gamma_curve(0.45, 4.5, 2,
 * (t_white << 3) / bright)` dengan `t_white = 0x2000` bila `no_auto_bright`
 * -- `imax = 0x10000`. Nilai linear dipulihkan dengan membalik tabel yang
 * SAMA PERSIS, bukan rumus gamma analitik: pembulatan `(int)` tabel itulah
 * yang harus dibatalkan.
 */

/** Port `LibRaw::gamma_curve` (dcraw `gamma_curve`), `mode` 2 = tabel 16-bit. */
export function dcrawGammaCurve(pwr: number, ts: number, mode: number, imax: number): Uint16Array {
  const g = [pwr, ts, 0, 0, 0, 0];
  const bnd = [0, 0];
  bnd[g[1]! >= 1 ? 1 : 0] = 1;
  if (g[1] && (g[1] - 1) * (g[0]! - 1) <= 0) {
    for (let i = 0; i < 48; i += 1) {
      g[2] = (bnd[0]! + bnd[1]!) / 2;
      if (g[0]) bnd[(Math.pow(g[2] / g[1], -g[0]) - 1) / g[0] - 1 / g[2] > -1 ? 1 : 0] = g[2];
      else bnd[g[2] / Math.exp(1 - 1 / g[2]) < g[1] ? 1 : 0] = g[2];
    }
    g[3] = g[2]! / g[1];
    if (g[0]) g[4] = g[2]! * (1 / g[0] - 1);
  }
  const curve = new Uint16Array(0x10000);
  const m = mode - 1;
  for (let i = 0; i < 0x10000; i += 1) {
    curve[i] = 0xffff;
    const r = i / imax;
    if (r < 1) {
      const v = m
        ? r < g[3]!
          ? r * g[1]!
          : g[0]
            ? Math.pow(r, g[0]) * (1 + g[4]!) - g[4]!
            : Math.log(r) * g[2]! + 1
        : 0;
      curve[i] = Math.min(0xffff, Math.trunc(0x10000 * v));
    }
  }
  return curve;
}

/**
 * Invers tabel: nilai ter-encode `e` -> kode linear `L` (0..65535) di TENGAH
 * rentang `L` yang dipetakan ke `e`. Di wilayah gelap kurva injektif
 * (kemiringan >= 1), jadi inversnya eksak. Nilai `e` yang tidak pernah
 * dihasilkan kurva (celah di wilayah curam) diisi interpolasi linear antara
 * tetangganya -- LibRaw tidak akan mengeluarkannya, tapi tabel tetap total.
 */
export function invertDcrawCurve(curve: Uint16Array): Float64Array {
  const lo = new Float64Array(0x10000).fill(-1);
  const hi = new Float64Array(0x10000).fill(-1);
  for (let l = 0; l < curve.length; l += 1) {
    const e = curve[l]!;
    if (lo[e] === -1) lo[e] = l;
    hi[e] = l;
  }
  const inv = new Float64Array(0x10000).fill(Number.NaN);
  for (let e = 0; e < 0x10000; e += 1) if (lo[e] !== -1) inv[e] = (lo[e]! + hi[e]!) / 2;
  let prev = -1;
  for (let e = 0; e < 0x10000; e += 1) {
    if (Number.isNaN(inv[e])) continue;
    if (prev >= 0 && e - prev > 1) {
      for (let k = prev + 1; k < e; k += 1) inv[k] = inv[prev]! + ((inv[e]! - inv[prev]!) * (k - prev)) / (e - prev);
    }
    prev = e;
  }
  // Di atas nilai tertinggi yang dihasilkan: jenuh.
  for (let e = prev + 1; e < 0x10000; e += 1) inv[e] = inv[prev]!;
  return inv;
}
