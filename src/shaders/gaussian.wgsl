// Primitif Gaussian bersama (Fase 2A.5): port `utils/fast_gaussian_filter.py`
// spektrafilm, per kanal RGB, di dalam satu rektangel buffer.
//
// - FIR (sigma < 3): kernel `_gaussian_kernel_1d` (dihitung host), pass
//   VERTIKAL lalu HORIZONTAL seperti `_fir_2d_fused`, batas reflect periodik
//   persis `_reflect` (scipy mode='reflect', "d c b a | a b c d | d c b a").
// - IIR (sigma >= 3): Young & van Vliet orde 3 (`_yvv_coeffs`, host), pass
//   HORIZONTAL lalu VERTIKAL seperti `_gaussian_filter_2d_large`, maju lalu
//   mundur, keadaan awal = sampel tepi (replikasi) persis `_iir_horizontal`/
//   `_iir_vertical`. Satu invokasi per baris/kolom karena rekursinya
//   berurutan.
//
// Hanya kanal di `channelMask` yang ditulis (baca-ubah-tulis vec4), supaya
// jalur FIR dan IIR bisa melayani kanal berbeda pada buffer yang sama.
// Semua indeks batas relatif terhadap rektangel, bukan buffer: di bawah
// tiling, rektangel adalah data yang masih sah, dan rekursi IIR tidak boleh
// menarik nilai basi dari luarnya.

struct BlurParams {
  bufferWidth: u32,
  bufferHeight: u32,
  rectX: u32,
  rectY: u32,
  rectW: u32,
  rectH: u32,
  op: u32,
  channelMask: u32,
  radius: vec4<u32>,
  // Koefisien IIR sebagai df64: bagian hi di .xyz kanal R/G/B, bagian lo
  // di struct terpisah (lih. catatan presisi di atas `dfMul`).
  iirB: vec4<f32>,
  iirB1: vec4<f32>,
  iirB2: vec4<f32>,
  iirB3: vec4<f32>,
  iirBLo: vec4<f32>,
  iirB1Lo: vec4<f32>,
  iirB2Lo: vec4<f32>,
  iirB3Lo: vec4<f32>,
  amplitude: f32,
  first: u32,
  _pad0: u32,
  _pad1: u32,
}

@group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> scratch: array<vec4<f32>>;
@group(0) @binding(3) var<uniform> p: BlurParams;
@group(0) @binding(4) var<storage, read> weights: array<f32>;

const kOpCopy: u32 = 0u;
const kOpFirV: u32 = 1u;
const kOpFirH: u32 = 2u;
const kOpIirH: u32 = 3u;
const kOpIirV: u32 = 4u;
const kOpScaleAdd: u32 = 5u;

const kMaxRadius: i32 = 32;
const kStride: u32 = 65u; // 2 * kMaxRadius + 1

fn reflectIndex(i: i32, n: i32) -> i32 {
  if (i >= 0 && i < n) { return i; }
  if (i >= -n && i < 0) { return -i - 1; }
  if (i >= n && i < 2 * n) { return 2 * n - 1 - i; }
  let period = 2 * n;
  var j = i % period;
  if (j < 0) { j = j + period; }
  if (j >= n) { j = period - 1 - j; }
  return j;
}

// PRESISI IIR. Untuk sigma besar koefisien YvV hampir saling menghapus
// (B = 1 - (b1+b2+b3) ~ 2e-3 pada sigma 13, jauh lebih kecil pada sigma 90):
// pembulatan f32 pada koefisien menggeser gain DC, dan galat pembulatan
// rekursi diperkuat ~1/B. Terukur 1e-4..1.6e-3 terhadap hulu (numba f64)
// dengan f32 polos. Karena itu rekursi dihitung dalam double-float (df64:
// pasangan hi+lo f32) dengan transformasi bebas galat: two-sum Knuth dan
// two-prod dengan split Dekker (TIDAK bergantung pada `fma` yang belum tentu
// fused; aman bila compiler mengontraksi mul+add, karena perkalian setengah-
// mantisa Dekker eksak). Yang mematahkannya hanya reasosiasi fast-math --
// risiko portabilitas yang dicatat di spec Fase 2 §6a. Nilai antar-pass tetap
// disimpan f32 (galat input tidak diperkuat: gain DC filter = 1).

fn twoSum(a: f32, b: f32) -> vec2<f32> {
  let s = a + b;
  let bb = s - a;
  return vec2<f32>(s, (a - (s - bb)) + (b - bb));
}

fn quickTwoSum(a: f32, b: f32) -> vec2<f32> {
  let s = a + b;
  return vec2<f32>(s, b - (s - a));
}

fn split(a: f32) -> vec2<f32> {
  let t = 4097.0 * a;
  let hi = t - (t - a);
  return vec2<f32>(hi, a - hi);
}

fn twoProd(a: f32, b: f32) -> vec2<f32> {
  let p = a * b;
  let sa = split(a);
  let sb = split(b);
  let err = ((sa.x * sb.x - p) + sa.x * sb.y + sa.y * sb.x) + sa.y * sb.y;
  return vec2<f32>(p, err);
}

fn dfAdd(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  var s = twoSum(a.x, b.x);
  let t = twoSum(a.y, b.y);
  s.y = s.y + t.x;
  s = quickTwoSum(s.x, s.y);
  s.y = s.y + t.y;
  return quickTwoSum(s.x, s.y);
}

fn dfMul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  var p = twoProd(a.x, b.x);
  p.y = p.y + (a.x * b.y + a.y * b.x);
  return quickTwoSum(p.x, p.y);
}

/** Satu langkah rekursi YvV: B*x + b1*w1 + b2*w2 + b3*w3, semua df64. */
fn yvvStep(c: u32, x: vec2<f32>, w1: vec2<f32>, w2: vec2<f32>, w3: vec2<f32>) -> vec2<f32> {
  let B = vec2<f32>(p.iirB[c], p.iirBLo[c]);
  let B1 = vec2<f32>(p.iirB1[c], p.iirB1Lo[c]);
  let B2 = vec2<f32>(p.iirB2[c], p.iirB2Lo[c]);
  let B3 = vec2<f32>(p.iirB3[c], p.iirB3Lo[c]);
  return dfAdd(dfAdd(dfMul(B, x), dfMul(B1, w1)), dfAdd(dfMul(B2, w2), dfMul(B3, w3)));
}

fn at(x: u32, y: u32) -> u32 {
  return (p.rectY + y) * p.bufferWidth + p.rectX + x;
}

fn inMask(c: u32) -> bool {
  return (p.channelMask & (1u << c)) != 0u;
}

fn weight(c: u32, k: i32) -> f32 {
  return weights[c * kStride + u32(kMaxRadius + k)];
}

@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (p.op == kOpIirH) {
    let y = gid.x;
    if (y >= p.rectH) { return; }
    let n = p.rectW;
    for (var c: u32 = 0u; c < 3u; c = c + 1u) {
      if (!inMask(c)) { continue; }
      let x0 = vec2<f32>(src[at(0u, y)][c], 0.0);
      var w1 = x0;
      var w2 = x0;
      var w3 = x0;
      for (var x: u32 = 0u; x < n; x = x + 1u) {
        let w = yvvStep(c, vec2<f32>(src[at(x, y)][c], 0.0), w1, w2, w3);
        var v = scratch[at(x, y)];
        v[c] = w.x + w.y;
        scratch[at(x, y)] = v;
        w3 = w2;
        w2 = w1;
        w1 = w;
      }
      // Hulu memulai arah mundur dari keluaran maju yang sudah tersimpan
      // (f64 di sana); di sini dari nilai df64 terakhir, sebelum dibulatkan.
      let xn = w1;
      var y1 = xn;
      var y2 = xn;
      var y3 = xn;
      for (var i: u32 = 0u; i < n; i = i + 1u) {
        let x = n - 1u - i;
        var v = scratch[at(x, y)];
        let out = yvvStep(c, vec2<f32>(v[c], 0.0), y1, y2, y3);
        v[c] = out.x + out.y;
        scratch[at(x, y)] = v;
        y3 = y2;
        y2 = y1;
        y1 = out;
      }
    }
    return;
  }

  if (p.op == kOpIirV) {
    let x = gid.x;
    if (x >= p.rectW) { return; }
    let n = p.rectH;
    for (var c: u32 = 0u; c < 3u; c = c + 1u) {
      if (!inMask(c)) { continue; }
      let x0 = vec2<f32>(scratch[at(x, 0u)][c], 0.0);
      var s1 = x0;
      var s2 = x0;
      var s3 = x0;
      for (var y: u32 = 0u; y < n; y = y + 1u) {
        let w = yvvStep(c, vec2<f32>(scratch[at(x, y)][c], 0.0), s1, s2, s3);
        var v = dst[at(x, y)];
        v[c] = w.x + w.y;
        dst[at(x, y)] = v;
        s3 = s2;
        s2 = s1;
        s1 = w;
      }
      let xn = s1;
      s1 = xn;
      s2 = xn;
      s3 = xn;
      for (var i: u32 = 0u; i < n; i = i + 1u) {
        let y = n - 1u - i;
        var v = dst[at(x, y)];
        let out = yvvStep(c, vec2<f32>(v[c], 0.0), s1, s2, s3);
        v[c] = out.x + out.y;
        dst[at(x, y)] = v;
        s3 = s2;
        s2 = s1;
        s1 = out;
      }
    }
    return;
  }

  // Operasi per piksel: gid.x = kolom, gid.y = baris di dalam rektangel.
  let x = gid.x;
  let y = gid.y;
  if (x >= p.rectW || y >= p.rectH) { return; }
  let index = at(x, y);

  if (p.op == kOpCopy) {
    dst[index] = src[index];
    return;
  }

  if (p.op == kOpFirV) {
    var v = scratch[index];
    for (var c: u32 = 0u; c < 3u; c = c + 1u) {
      if (!inMask(c)) { continue; }
      let r = i32(p.radius[c]);
      var sum: f32 = 0.0;
      for (var k: i32 = -r; k <= r; k = k + 1) {
        let yy = u32(reflectIndex(i32(y) + k, i32(p.rectH)));
        sum = sum + src[at(x, yy)][c] * weight(c, k);
      }
      v[c] = sum;
    }
    scratch[index] = v;
    return;
  }

  if (p.op == kOpFirH) {
    var v = dst[index];
    for (var c: u32 = 0u; c < 3u; c = c + 1u) {
      if (!inMask(c)) { continue; }
      let r = i32(p.radius[c]);
      var sum: f32 = 0.0;
      for (var k: i32 = -r; k <= r; k = k + 1) {
        let xx = u32(reflectIndex(i32(x) + k, i32(p.rectW)));
        sum = sum + scratch[at(xx, y)][c] * weight(c, k);
      }
      v[c] = sum;
    }
    dst[index] = v;
    return;
  }

  if (p.op == kOpScaleAdd) {
    // `fast_exponential_filter`: result = a0*c0; result += a1*c1; ...
    // `src` di sini adalah komponen ter-blur, `dst` akumulator. Alpha
    // komponen = alpha input (pass Copy membawanya), jadi diambil dari sana.
    let term = p.amplitude * src[index].rgb;
    let acc = select(dst[index].rgb + term, term, p.first == 1u);
    dst[index] = vec4<f32>(acc, src[index].a);
    return;
  }
}
