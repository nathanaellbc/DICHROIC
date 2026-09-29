// Konvolusi FFT 2D presisi df64 untuk filter difusi (Fase 2D Task 4).
//
// Python (`model/diffusion.py::apply_diffusion_filter_um`) menjalankan
// `fftconvolve(reflect_pad(image, r), psf, mode='same')` dalam f64. FFT f32
// TIDAK cukup: derau pembulatannya menyebar rata ke seluruh bidang, dan di
// bayangan dalam di samping highlight galat relatifnya 1e-4 (terukur 5e-5..3e-4
// pada log10 untuk keempat family, jauh di atas ambang 1e-5). Maka seluruh
// FFT -- data, twiddle, kernel -- dihitung dalam double-float (df64: pasangan
// f32 hi+lo dengan two-sum Knuth dan two-prod Dekker, sama dengan `gaussian.wgsl`).
//
// Satu elemen kompleks = vec4<f32>(reHi, reLo, imHi, imLo).
//
// Entry point (satu per pipeline):
//   fillImage   -- piksel sumber -> bidang kompleks (kanal A + i kanal B),
//                  dipad `reflect` sebesar r (numpy 'reflect'), nol di luar.
//   fillKernel  -- PSF df64 (dua kanal) -> bidang kompleks, dibungkus sirkular
//                  dengan pusat di (0, 0) (kernel genap -> spektrum real).
//   stockham    -- satu pass radix-2 Stockham (autosort) sepanjang baris atau kolom.
//   multiply    -- pisahkan spektrum dua kanal real dari satu FFT kompleks,
//                  kalikan masing-masing dengan spektrum kernelnya.
//   resolve     -- (1 - p) * sumber + p * konvolusi (+ log10 untuk situs print).

struct FftParams {
  nx: u32,
  ny: u32,
  width: u32,
  height: u32,
  radius: u32,
  n: u32,
  ns: u32,
  axis: u32,
  inverse: u32,
  chA: u32,
  chB: u32,
  opaqueZero: u32,
  scatter: f32,
  finalLog: u32,
  scale: f32,
  kernelSize: u32,
}

@group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> dst: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> p: FftParams;
@group(0) @binding(3) var<storage, read> aux: array<vec4<f32>>;

// ---- df64 (salinan `gaussian.wgsl`; `opq` menghalangi compiler
// menyederhanakan two-sum/two-prod dengan asumsi fast-math) ----

fn opq(x: f32) -> f32 {
  return bitcast<f32>(bitcast<u32>(x) ^ p.opaqueZero);
}

fn twoSum(a: f32, b: f32) -> vec2<f32> {
  let s = opq(a + b);
  let bb = opq(s - a);
  return vec2<f32>(s, (a - opq(s - bb)) + (b - bb));
}

fn quickTwoSum(a: f32, b: f32) -> vec2<f32> {
  let s = opq(a + b);
  return vec2<f32>(s, b - opq(s - a));
}

fn split(a: f32) -> vec2<f32> {
  let t = opq(4097.0 * a);
  let hi = t - opq(t - a);
  return vec2<f32>(hi, a - hi);
}

fn twoProd(a: f32, b: f32) -> vec2<f32> {
  let prod = opq(a * b);
  let sa = split(a);
  let sb = split(b);
  let err = ((sa.x * sb.x - prod) + sa.x * sb.y + sa.y * sb.x) + sa.y * sb.y;
  return vec2<f32>(prod, err);
}

fn dfAdd(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  var s = twoSum(a.x, b.x);
  let t = twoSum(a.y, b.y);
  s.y = s.y + t.x;
  s = quickTwoSum(s.x, s.y);
  s.y = s.y + t.y;
  return quickTwoSum(s.x, s.y);
}

fn dfNeg(a: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(-a.x, -a.y);
}

fn dfMul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  var prod = twoProd(a.x, b.x);
  prod.y = prod.y + (a.x * b.y + a.y * b.x);
  return quickTwoSum(prod.x, prod.y);
}

// ---- kompleks df64 ----

fn cAdd(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(dfAdd(a.xy, b.xy), dfAdd(a.zw, b.zw));
}

fn cSub(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(dfAdd(a.xy, dfNeg(b.xy)), dfAdd(a.zw, dfNeg(b.zw)));
}

fn cMul(a: vec4<f32>, b: vec4<f32>) -> vec4<f32> {
  let re = dfAdd(dfMul(a.xy, b.xy), dfNeg(dfMul(a.zw, b.zw)));
  let im = dfAdd(dfMul(a.xy, b.zw), dfMul(a.zw, b.xy));
  return vec4<f32>(re, im);
}

fn cConj(a: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(a.xy, dfNeg(a.zw));
}

// Indeks global linier dari dispatch 2D (256 thread per workgroup di x).
fn linearIndex(gid: vec3<u32>, groups: vec3<u32>) -> u32 {
  return gid.y * groups.x * 256u + gid.x;
}

// numpy `np.pad(mode='reflect')`: "d c b | a b c d | c b a" (tepi tidak
// diduplikasi). Satu pantulan cukup karena r <= min(h, w) // 2 - 1.
fn reflect(i: i32, n: i32) -> i32 {
  if (i < 0) {
    return -i;
  }
  if (i >= n) {
    return 2 * (n - 1) - i;
  }
  return i;
}

fn channel(v: vec4<f32>, c: u32) -> f32 {
  if (c == 0u) { return v.x; }
  if (c == 1u) { return v.y; }
  if (c == 2u) { return v.z; }
  if (c == 3u) { return v.w; }
  return 0.0;
}

@compute @workgroup_size(256, 1, 1)
fn fillImage(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let t = linearIndex(gid, groups);
  if (t >= p.nx * p.ny) {
    return;
  }
  let x = t % p.nx;
  let y = t / p.nx;
  let r = p.radius;
  if (x >= p.width + 2u * r || y >= p.height + 2u * r) {
    dst[t] = vec4<f32>(0.0);
    return;
  }
  let ix = reflect(i32(x) - i32(r), i32(p.width));
  let iy = reflect(i32(y) - i32(r), i32(p.height));
  let pixel = src[u32(iy) * p.width + u32(ix)];
  dst[t] = vec4<f32>(channel(pixel, p.chA), 0.0, channel(pixel, p.chB), 0.0);
}

// `src` = PSF df64 (2r+1)^2, vec4(kaHi, kaLo, kbHi, kbLo) baris-mayor.
@compute @workgroup_size(256, 1, 1)
fn fillKernel(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let t = linearIndex(gid, groups);
  if (t >= p.nx * p.ny) {
    return;
  }
  let x = i32(t % p.nx);
  let y = i32(t / p.nx);
  let r = i32(p.radius);
  let dx = select(x, x - i32(p.nx), x > r);
  let dy = select(y, y - i32(p.ny), y > r);
  if (dx < -r || dx > r || dy < -r || dy > r) {
    dst[t] = vec4<f32>(0.0);
    return;
  }
  let size = i32(p.kernelSize);
  dst[t] = src[u32((dy + r) * size + (dx + r))];
}

// Satu pass Stockham radix-2 (Ns = 1, 2, ..., n/2), keluaran urutan natural
// setelah log2(n) pass. `aux` = twiddle df64 exp(-2 pi i m / n), m < n/2.
@compute @workgroup_size(256, 1, 1)
fn stockham(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let t = linearIndex(gid, groups);
  let half = p.n / 2u;
  if (t >= p.nx * p.ny / 2u) {
    return;
  }
  var j: u32;
  var line: u32;
  if (p.axis == 0u) {
    line = t / half;
    j = t % half;
  } else {
    line = t % p.nx;
    j = t / p.nx;
  }
  let k = j % p.ns;
  let m = k * (p.n / (2u * p.ns));
  var tw = aux[m];
  if (p.inverse != 0u) {
    tw = cConj(tw);
  }
  let outIndex = (j / p.ns) * 2u * p.ns + k;

  var ia: u32;
  var ib: u32;
  var oa: u32;
  var ob: u32;
  if (p.axis == 0u) {
    let base = line * p.nx;
    ia = base + j;
    ib = base + j + half;
    oa = base + outIndex;
    ob = base + outIndex + p.ns;
  } else {
    ia = j * p.nx + line;
    ib = (j + half) * p.nx + line;
    oa = outIndex * p.nx + line;
    ob = (outIndex + p.ns) * p.nx + line;
  }
  let a = src[ia];
  let b = cMul(src[ib], tw);
  dst[oa] = cAdd(a, b);
  dst[ob] = cSub(a, b);
}

// `src` = Z = FFT(a + i b) untuk a, b real; `aux` = K = FFT(ka + i kb) = Ka + i Kb
// (ka, kb real dan genap -> Ka, Kb real). Keluaran W = A Ka + i (B Kb), sehingga
// IFFT(W) = (a * ka) + i (b * kb).
@compute @workgroup_size(256, 1, 1)
fn multiply(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let t = linearIndex(gid, groups);
  if (t >= p.nx * p.ny) {
    return;
  }
  let kx = t % p.nx;
  let ky = t / p.nx;
  let nxNeg = (p.nx - kx) % p.nx;
  let nyNeg = (p.ny - ky) % p.ny;
  let z = src[t];
  let zn = cConj(src[nyNeg * p.nx + nxNeg]);
  let sum = cAdd(z, zn);
  let diff = cSub(z, zn);
  let half = vec2<f32>(0.5, 0.0);
  // A = (Z + conj Z[-k]) / 2; B = (Z - conj Z[-k]) / (2i) = (Im D / 2, -Re D / 2).
  let aRe = dfMul(sum.xy, half);
  let aIm = dfMul(sum.zw, half);
  let bRe = dfMul(diff.zw, half);
  let bIm = dfNeg(dfMul(diff.xy, half));
  let kern = aux[t];
  let ka = kern.xy;
  let kb = kern.zw;
  // W = (Ar Ka - Bi Kb) + i (Ai Ka + Br Kb)
  let wRe = dfAdd(dfMul(aRe, ka), dfNeg(dfMul(bIm, kb)));
  let wIm = dfAdd(dfMul(aIm, ka), dfMul(bRe, kb));
  dst[t] = vec4<f32>(wRe, wIm);
}

const kLog10E: f32 = 0.4342944819032518;

// `src` = hasil IFFT (belum diskalakan), `aux` = piksel sumber tahap, `dst` =
// piksel tujuan (kanal lain dipertahankan dari pass sebelumnya).
@compute @workgroup_size(256, 1, 1)
fn resolve(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) groups: vec3<u32>) {
  let t = linearIndex(gid, groups);
  if (t >= p.width * p.height) {
    return;
  }
  let x = t % p.width;
  let y = t / p.width;
  let c = src[(y + p.radius) * p.nx + (x + p.radius)];
  let original = aux[t];
  var out = select(dst[t], original, p.chA == 0u);
  let convA = (c.x + c.y) * p.scale;
  let convB = (c.z + c.w) * p.scale;
  var va = (1.0 - p.scatter) * channel(original, p.chA) + p.scatter * convA;
  var vb = (1.0 - p.scatter) * channel(original, p.chB) + p.scatter * convB;
  if (p.finalLog != 0u) {
    va = log(max(va, 0.0) + 1.0e-10) * kLog10E;
    vb = log(max(vb, 0.0) + 1.0e-10) * kLog10E;
  }
  if (p.chA == 0u) {
    out.x = va;
    out.y = vb;
    if (p.finalLog != 0u) {
      // Kanal B menyusul di pass kedua; alpha dipertahankan.
      out.z = original.z;
    }
  } else {
    out.z = va;
  }
  dst[t] = out;
}
