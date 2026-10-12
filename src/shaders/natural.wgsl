// "Natural" (ekstensi DICHROIC): membalik gaya ISP HP pada input ter-encode,
// sebelum filmExposure. Lihat `host/naturalize.ts` (naturalPixel = referensi
// CPU dengan numerik yang sama). Satu lintasan per piksel.

struct Cfg {
  size: vec4<u32>,      // lebar tile, tinggi tile, lebar penuh, tinggi penuh
  origin: vec4<u32>,    // asal tile x, y, lebar peta, tinggi peta
  ctl: vec4<f32>,       // amount, logMean, lutMin, lutMax
  luma: vec4<f32>,      // bobot luminans, jumlah entri tabel
  strength0: vec4<f32>, // tone, local, highlight, vibrance
  strength1: vec4<f32>, // clipDesaturate, noise, gain (kompensasi eksposur), vibranceKnee
}

@group(0) @binding(0) var<storage, read> source: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> dest: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> lut: array<f32>;
@group(0) @binding(3) var<storage, read> grid: array<f32>;
@group(0) @binding(4) var<uniform> cfg: Cfg;

fn decode(v: f32) -> f32 {
  let n = u32(cfg.luma.w);
  let t = clamp((v - cfg.ctl.z) / (cfg.ctl.w - cfg.ctl.z), 0.0, 1.0) * f32(n - 1u);
  let i = min(u32(floor(t)), n - 2u);
  let a = lut[i];
  let b = lut[i + 1u];
  return a + (b - a) * (t - f32(i));
}

fn encode(x: f32) -> f32 {
  let n = u32(cfg.luma.w);
  if (x <= lut[0]) { return cfg.ctl.z; }
  if (x >= lut[n - 1u]) { return cfg.ctl.w; }
  var lo = 0u;
  var hi = n - 1u;
  for (var k = 0; k < 13; k = k + 1) {
    let mid = (lo + hi) >> 1u;
    if (lut[mid] <= x) { lo = mid; } else { hi = mid; }
  }
  let a = lut[lo];
  let b = lut[lo + 1u];
  var t = 0.0;
  if (b > a) { t = (x - a) / (b - a); }
  return cfg.ctl.z + ((f32(lo) + t) / f32(n - 1u)) * (cfg.ctl.w - cfg.ctl.z);
}

fn inverseSmoothstep(y: f32) -> f32 {
  let c = clamp(y, 0.0, 1.0);
  return 0.5 - sin(asin(1.0 - 2.0 * c) / 3.0);
}

fn unTone(e: f32, s: f32) -> f32 {
  if (e >= 0.0 && e <= 1.0) {
    return e + (inverseSmoothstep(e) - e) * cfg.strength0.x * s;
  }
  return e;
}

fn gridAt(uv: vec2<f32>) -> f32 {
  let gw = cfg.origin.z;
  let gh = cfg.origin.w;
  let p = clamp(uv * vec2<f32>(f32(gw), f32(gh)) - 0.5, vec2<f32>(0.0), vec2<f32>(f32(gw - 1u), f32(gh - 1u)));
  let p0 = vec2<u32>(floor(p));
  let p1 = min(p0 + 1u, vec2<u32>(gw - 1u, gh - 1u));
  let t = p - vec2<f32>(p0);
  let a = mix(grid[p0.y * gw + p0.x], grid[p0.y * gw + p1.x], t.x);
  let b = mix(grid[p1.y * gw + p0.x], grid[p1.y * gw + p1.x], t.x);
  return mix(a, b, t.y);
}

fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn pixelNoise(x: u32, y: u32) -> f32 {
  var h = pcg(y * 65537u + x);
  var s = 0.0;
  for (var k = 0; k < 4; k = k + 1) {
    h = pcg(h);
    s += f32(h) / 4294967296.0;
  }
  return (s - 2.0) * 1.7320508075688772;
}

@compute @workgroup_size(16, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= cfg.size.x || gid.y >= cfg.size.y) {
    return;
  }
  let i = gid.y * cfg.size.x + gid.x;
  let src = source[i];
  let s = cfg.ctl.x;
  // 1-2. Linear, lalu kurva S kamera dibalik HANYA pada luminans (nilai
  // ter-encode-nya); RGB ikut rasionya -- hue dan saturasi tidak tersentuh.
  let lin = vec3<f32>(decode(src.r), decode(src.g), decode(src.b));
  let Y = dot(cfg.luma.xyz, lin);
  if (!(Y > 1.0e-5)) {
    dest[i] = src;
    return;
  }
  let Ye = encode(Y);
  var Yt = Y;
  if (Ye >= 0.0 && Ye <= 1.0) {
    Yt = decode(unTone(Ye, s));
  }
  let ax = gid.x + cfg.origin.x;
  let ay = gid.y + cfg.origin.y;
  // 3. Kontras skala besar.
  let uv = (vec2<f32>(f32(ax), f32(ay)) + 0.5) / vec2<f32>(f32(cfg.size.z), f32(cfg.size.w));
  var Yn = Yt * cfg.strength1.z * exp(s * cfg.strength0.y * (gridAt(uv) - cfg.ctl.y));
  // 4. Highlight dekat-terpotong.
  let knee = smoothstep(0.82, 1.0, max(src.r, max(src.g, src.b)));
  Yn *= 1.0 + s * cfg.strength0.z * knee * knee;
  var c = lin * (Yn / Y);
  // 5. Vibrance: hanya saturasi di atas knee dikompres lembut; plus redam di
  // dekat potongan.
  let mx = max(c.r, max(c.g, c.b));
  let mn = min(c.r, min(c.g, c.b));
  let sat = (mx - mn) / max(mx, 1.0e-6);
  let kv = cfg.strength1.w;
  var satTarget = sat;
  if (sat > kv) {
    satTarget = kv + (sat - kv) * (1.0 - cfg.strength0.w * s);
  }
  var ratio = 1.0;
  if (sat > 1.0e-6) {
    ratio = satTarget / sat;
  }
  let keep = clamp(ratio * (1.0 - s * cfg.strength1.x * knee), 0.0, 1.0);
  c = vec3<f32>(Yn) + (c - vec3<f32>(Yn)) * keep;
  // 6. Derau sensor halus.
  let n = pixelNoise(ax, ay) * s * cfg.strength1.y * sqrt(max(Yn, 0.0));
  // 7. Kembali ke kurva input.
  dest[i] = vec4<f32>(encode(max(c.r + n, 0.0)), encode(max(c.g + n, 0.0)), encode(max(c.b + n, 0.0)), src.a);
}
