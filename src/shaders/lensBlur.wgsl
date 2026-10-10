// Lens blur (ekstensi DICHROIC di luar spektrafilm) -- defocus sintetis
// "scatter sebagai gather" pada setengah resolusi, medan dekat dan jauh
// dipisah. Teknik: depth of field pasca-proses Jimenez (Next Generation Post
// Processing in Call of Duty: Advanced Warfare, 2014) dan GPU Gems 3 bab 28;
// struktur pass-nya mengikuti defocus EMULSION (GLSL fragmen), ditulis ulang
// sebagai compute WGSL:
//
//   scene -+- prep (grid) -- mips -+- far gather (grid) ---+
//   depth -+         +-- tiles -- dilate -- near gather (grid) -+- combine (penuh)
//
// Semua pass bekerja di cahaya raw linear film SEBELUM halation dan develop:
// highlight yang tak fokus sampai di negatif sebagai cakram terang.
//
// Gather membalik scatter: di tiap piksel, kunjungi tetangga dan tanya cakram
// siapa yang menutupi piksel ini. Tiap tetangga diberi bobot kebalikan luas
// cakramnya, jadi titik cahaya kecil tetap membawa energinya berapa pun
// lebarnya menyebar. Dua medan, karena oklusi tidak simetris:
//  - di belakang bidang fokus, tetangga hanya boleh menyebar sejauh blur
//    piksel ini sendiri mengizinkan -- subjek tajam tidak pernah ditimpa latar
//    lembut di belakangnya;
//  - di depannya, foreground yang blur menyebar menutupi apa pun, jadi
//    cakramnya dikumpulkan terpisah (jangkauan dari tile 16 px yang
//    di-dilate) dan diletakkan di atas dengan coverage.
//
// Presisi: grid dan medan gather disimpan rgba16float (bisa di-filter linear
// dan di-mip); combine membaca adegan tajam langsung dari buffer f32, jadi
// piksel dengan CoC < 0,5 px (di dalam fokus) keluar BIT-IDENTIK dengan
// masukannya.
//
// Detail halus (rambut): buffer kedalaman membawa tiga bidang -- lapis depan,
// lapis belakang (latar di balik helai), dan alfa lapis depan (`depth/matte.ts`).
// Medan blur dibangun dari lapis belakang dengan warna lapis depan diredam
// (bobot 1 - alfa di prep), lalu combine mencampur hasil lapis belakang dan
// lapis depan dengan alfa: latar blur tembus di sela helai yang tetap tajam.
// Di luar zona tepi (alfa 1, depan = belakang) semua jalur identik dengan
// satu lapis.

struct Lens {
  fullSize: vec2<u32>,
  gridSize: vec2<u32>,
  depthSize: vec2<u32>,
  tileCount: vec2<u32>,
  focusDisparity: f32,
  cocScale: f32,       // diameter CoC subjek di tak hingga, px render
  maxCoc: f32,         // diameter terbesar yang digambar, px render
  nearDisparity: f32,
  foreground: f32,
  gridScale: f32,      // px grid per px render
  curvature: f32,
  catEye: f32,
  aspect: vec2<f32>,   // (W, H) / hypot(W, H): sudut bingkai di panjang 1
  blades: u32,
  reach: u32,          // jangkauan dilate, tile
}

const PI: f32 = 3.141592653589793;
const GOLDEN_ANGLE: f32 = 2.399963229728653;
const MIN_FOCUS_DISPARITY: f32 = 0.02;
const MAX_SAMPLES: i32 = 256;
// Jarak target antar sampel gather (px grid).
const SAMPLE_SPACING: f32 = 1.6;
// Cakram lebih kecil dari ini (radius px grid) bukan urusan grid: combine
// mem-blur-nya di resolusi penuh.
const GRID_MIN_RADIUS: f32 = 1.0;
const TILE: i32 = 16;
const MAX_REACH: i32 = 8;
const SMALL_TAPS: i32 = 16;

@group(0) @binding(0) var<uniform> lens: Lens;
@group(0) @binding(1) var<storage, read> scene: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> depth: array<f32>;

// --- bersama ----------------------------------------------------------------

// Bidang `plane` buffer kedalaman (0 depan, 1 belakang, 2 alfa), bilinear.
fn planeAt(uv: vec2<f32>, plane: u32) -> f32 {
  let size = vec2<f32>(lens.depthSize);
  let p = clamp(uv * size - 0.5, vec2<f32>(0.0), size - 1.0);
  let p0 = vec2<u32>(floor(p));
  let p1 = min(p0 + 1u, lens.depthSize - 1u);
  let t = p - vec2<f32>(p0);
  let w = lens.depthSize.x;
  let o = plane * w * lens.depthSize.y;
  let a = mix(depth[o + p0.y * w + p0.x], depth[o + p0.y * w + p1.x], t.x);
  let b = mix(depth[o + p1.y * w + p0.x], depth[o + p1.y * w + p1.x], t.x);
  return mix(a, b, t.y);
}

fn depthAt(uv: vec2<f32>) -> f32 {
  return planeAt(uv, 0u);
}

fn alphaAt(uv: vec2<f32>) -> f32 {
  return planeAt(uv, 2u);
}

// Lapis depan yang blur di depan bidang fokus ditangani medan dekat seperti
// biasa (diameter CoC px render); dua lapis hanya berlaku bila lapis depan
// fokus atau di belakangnya -- kasus potret.
const NEAR_LAYER_PX: f32 = 1.0;

// Kedalaman yang dipakai medan blur: lapis belakang (latar di balik helai),
// kecuali lapis depan sendiri blur di depan bidang fokus.
fn fieldDepth(uv: vec2<f32>) -> f32 {
  let f = depthAt(uv);
  if (signedCoc(f) < -NEAR_LAYER_PX) {
    return f;
  }
  return planeAt(uv, 1u);
}

// Diameter CoC bertanda, px render: + di belakang bidang fokus, - di depan
// (`host/lens.ts`, signedCocPx).
fn signedCoc(d: f32) -> f32 {
  let df = max(lens.focusDisparity, MIN_FOCUS_DISPARITY);
  var c = lens.cocScale * (1.0 - d / df);
  if (c < 0.0) {
    let dn = max(lens.nearDisparity, df);
    c = -lens.cocScale * max(d - dn, 0.0) * lens.foreground / df;
  }
  return clamp(c, -lens.maxCoc, lens.maxCoc);
}

// Iris: jarak bertanda ke tepi cakram (px grid, + di dalam). `v` = offset dari
// pusat cakram ke titik yang ditanya, `r` = radius. Bilah: n-gon di dalam
// lingkaran, dicampur ke lingkaran oleh kelengkungan. Cat's eye (vignetting
// optik): irisan dua lingkaran yang digeser radial.
fn apertureEdge(v: vec2<f32>, r: f32, radialDir: vec2<f32>, catOffset: f32) -> f32 {
  let len = length(v);
  var edge = r;
  if (lens.blades >= 5u) {
    let n = f32(lens.blades);
    let seg = 2.0 * PI / n;
    let a = atan2(v.y, v.x) + PI * 0.5;
    let t = (a - floor(a / seg) * seg) - 0.5 * seg;
    let poly = cos(PI / n) / cos(t);
    edge = r * mix(poly, 1.0, lens.curvature);
  }
  var d = edge - len;
  if (catOffset > 0.0) {
    let c = radialDir * (0.5 * catOffset * r);
    d = min(d, min(r - length(v - c), r - length(v + c)));
  }
  return d;
}

fn catEyeDir(uv: vec2<f32>) -> vec3<f32> {
  let p = (uv - 0.5) * 2.0 * lens.aspect;
  let rr = length(p);
  let dir = select(vec2<f32>(1.0, 0.0), p / rr, rr > 1.0e-5);
  return vec3<f32>(dir, lens.catEye * 1.2 * rr * rr);
}

// Spiral sudut emas Vogel: N titik berluas sama di cakram satuan.
fn vogel(k: i32, n: i32) -> vec2<f32> {
  let rho = sqrt((f32(k) + 0.5) / f32(n));
  let th = f32(k) * GOLDEN_ANGLE;
  return rho * vec2<f32>(cos(th), sin(th));
}

fn sampleCount(reach: f32) -> i32 {
  let n = ceil(PI * reach * reach / (SAMPLE_SPACING * SAMPLE_SPACING));
  return i32(clamp(n, 8.0, f32(MAX_SAMPLES)));
}

// Gather jarang akan melewatkan titik terang kecil di antara sampelnya; tiap
// sampel membaca level mip selebar jaraknya -- tapi tidak pernah lebih lebar
// dari cakram yang diwakilinya.
fn sampleLod(spacing: f32, r: f32) -> f32 {
  return max(log2(max(min(spacing, r), 1.0)), 0.0);
}

// --- 1. prep: grid (rata-rata kotak adegan) + radius CoC bertanda di alfa ---

@group(0) @binding(3) var gridOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn prep(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= lens.gridSize.x || gid.y >= lens.gridSize.y) {
    return;
  }
  let W = lens.fullSize.x;
  let H = lens.fullSize.y;
  let x0 = (gid.x * W) / lens.gridSize.x;
  let x1 = max(x0 + 1u, ((gid.x + 1u) * W) / lens.gridSize.x);
  let y0 = (gid.y * H) / lens.gridSize.y;
  let y1 = max(y0 + 1u, ((gid.y + 1u) * H) / lens.gridSize.y);
  let uv = (vec2<f32>(gid.xy) + 0.5) / vec2<f32>(lens.gridSize);
  // Warna sel: rata-rata kotak. Bila sel ini mewakili lapis belakang, piksel
  // lapis depan (helai) diredam dengan bobot 1 - alfa supaya warnanya tidak
  // ikut menyebar sebagai bokeh latar; sel yang seluruhnya lapis depan (atau
  // tanpa lapisan, alfa 1) kembali ke rata-rata biasa.
  let layered = signedCoc(depthAt(uv)) >= -NEAR_LAYER_PX;
  var c = vec3<f32>(0.0);
  var cb = vec3<f32>(0.0);
  var wb = 0.0;
  for (var y = y0; y < y1; y = y + 1u) {
    for (var x = x0; x < x1; x = x + 1u) {
      let s = scene[y * W + x].rgb;
      c += s;
      if (layered) {
        let wgt = 1.0 - alphaAt((vec2<f32>(f32(x), f32(y)) + 0.5) / vec2<f32>(lens.fullSize));
        cb += s * wgt;
        wb += wgt;
      }
    }
  }
  let count = f32((x1 - x0) * (y1 - y0));
  c /= count;
  if (wb > 0.05 * count) {
    c = cb / wb;
  }
  let coc = signedCoc(fieldDepth(uv));
  textureStore(gridOut, vec2<i32>(gid.xy), vec4<f32>(c, coc * 0.5 * lens.gridScale));
}

// --- 2. mips: kotak 2x2 dari level sebelumnya -------------------------------

@group(0) @binding(4) var mipSrc: texture_2d<f32>;
@group(0) @binding(5) var mipDst: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn mip(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dst = textureDimensions(mipDst);
  if (gid.x >= dst.x || gid.y >= dst.y) {
    return;
  }
  let src = vec2<i32>(textureDimensions(mipSrc)) - 1;
  let p = vec2<i32>(gid.xy) * 2;
  var c = vec4<f32>(0.0);
  c += textureLoad(mipSrc, min(p, src), 0);
  c += textureLoad(mipSrc, min(p + vec2<i32>(1, 0), src), 0);
  c += textureLoad(mipSrc, min(p + vec2<i32>(0, 1), src), 0);
  c += textureLoad(mipSrc, min(p + vec2<i32>(1, 1), src), 0);
  textureStore(mipDst, vec2<i32>(gid.xy), c * 0.25);
}

// --- 3. tiles: cakram depan terlebar (x) dan cakram apa pun terlebar (y) ----

@group(0) @binding(6) var gridTex: texture_2d<f32>;
@group(0) @binding(7) var<storage, read_write> tiles: array<vec2<f32>>;

@compute @workgroup_size(8, 8, 1)
fn tile(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= lens.tileCount.x || gid.y >= lens.tileCount.y) {
    return;
  }
  let size = vec2<i32>(lens.gridSize) - 1;
  let base = vec2<i32>(gid.xy) * TILE;
  var nearMax = 0.0;
  var anyMax = 0.0;
  for (var y = 0; y < TILE; y = y + 1) {
    for (var x = 0; x < TILE; x = x + 1) {
      let c = textureLoad(gridTex, min(base + vec2<i32>(x, y), size), 0).a;
      nearMax = max(nearMax, -c);
      anyMax = max(anyMax, abs(c));
    }
  }
  tiles[gid.y * lens.tileCount.x + gid.x] = vec2<f32>(nearMax, anyMax);
}

// --- 4. dilate: tile mewarisi cakram depan tetangga yang bisa menjangkaunya --

@group(0) @binding(8) var<storage, read> tilesIn: array<vec2<f32>>;
@group(0) @binding(9) var<storage, read_write> dilated: array<vec2<f32>>;

@compute @workgroup_size(8, 8, 1)
fn dilate(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= lens.tileCount.x || gid.y >= lens.tileCount.y) {
    return;
  }
  let count = vec2<i32>(lens.tileCount);
  let me = vec2<i32>(gid.xy);
  let own = tilesIn[gid.y * lens.tileCount.x + gid.x];
  var nearMax = own.x;
  let reach = i32(lens.reach);
  for (var y = -MAX_REACH; y <= MAX_REACH; y = y + 1) {
    if (abs(y) > reach) {
      continue;
    }
    for (var x = -MAX_REACH; x <= MAX_REACH; x = x + 1) {
      if (abs(x) > reach) {
        continue;
      }
      let q = me + vec2<i32>(x, y);
      if (any(q < vec2<i32>(0)) || any(q >= count)) {
        continue;
      }
      let r = tilesIn[u32(q.y) * lens.tileCount.x + u32(q.x)].x;
      // Celah antara tepi terdekat dua tile, px grid.
      let gap = f32(max(max(abs(x), abs(y)) - 1, 0) * TILE);
      if (r >= gap) {
        nearMax = max(nearMax, r);
      }
    }
  }
  dilated[gid.y * lens.tileCount.x + gid.x] = vec2<f32>(nearMax, own.y);
}

// --- 5. far gather: bidang fokus dan di belakangnya -------------------------

@group(0) @binding(10) var gridSampler: sampler;
@group(0) @binding(11) var farOut: texture_storage_2d<rgba16float, write>;

fn gridCoc(uv: vec2<f32>) -> f32 {
  let size = vec2<i32>(lens.gridSize);
  let p = clamp(vec2<i32>(floor(uv * vec2<f32>(size))), vec2<i32>(0), size - 1);
  return textureLoad(gridTex, p, 0).a;
}

@compute @workgroup_size(8, 8, 1)
fn far(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= lens.gridSize.x || gid.y >= lens.gridSize.y) {
    return;
  }
  let texel = 1.0 / vec2<f32>(lens.gridSize);
  let uv = (vec2<f32>(gid.xy) + 0.5) * texel;
  let centre = textureLoad(gridTex, vec2<i32>(gid.xy), 0);
  let rc = abs(centre.a);
  if (rc < 0.5) {
    textureStore(farOut, vec2<i32>(gid.xy), vec4<f32>(centre.rgb, 1.0));
    return;
  }
  let ce = catEyeDir(uv);
  let n = sampleCount(rc);
  let spacing = sqrt(PI * rc * rc / f32(n));
  var sum = vec3<f32>(0.0);
  var wsum = 0.0;
  for (var k = 0; k < MAX_SAMPLES; k = k + 1) {
    if (k >= n) {
      break;
    }
    let o = vogel(k, n) * rc;
    let suv = uv + o * texel;
    let cs = gridCoc(suv);
    // Sampel depan milik near gather.
    if (cs < -GRID_MIN_RADIUS) {
      continue;
    }
    // Yang lebih kecil dari dua blur yang memutuskan: tidak ada yang lembut
    // dilukis melintasi yang tajam.
    let r = min(abs(cs), rc);
    let cov = clamp(apertureEdge(-o, r, ce.xy, ce.z) + 0.5, 0.0, 1.0);
    if (cov <= 0.0) {
      continue;
    }
    let w = cov / (PI * max(r * r, 0.25));
    sum += textureSampleLevel(gridTex, gridSampler, suv, sampleLod(spacing, r)).rgb * w;
    wsum += w;
  }
  let outColor = select(centre.rgb, sum / max(wsum, 1.0e-30), wsum > 0.0);
  textureStore(farOut, vec2<i32>(gid.xy), vec4<f32>(outColor, 1.0));
}

// --- 6. near gather: cakram di depan bidang fokus, dengan coverage ---------

@group(0) @binding(12) var<storage, read> dilatedIn: array<vec2<f32>>;
@group(0) @binding(13) var nearOut: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn near(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= lens.gridSize.x || gid.y >= lens.gridSize.y) {
    return;
  }
  let texel = 1.0 / vec2<f32>(lens.gridSize);
  let uv = (vec2<f32>(gid.xy) + 0.5) * texel;
  let t = gid.xy / vec2<u32>(u32(TILE));
  let reach = dilatedIn[t.y * lens.tileCount.x + t.x].x;
  if (reach < 0.5) {
    textureStore(nearOut, vec2<i32>(gid.xy), vec4<f32>(0.0));
    return;
  }
  let ce = catEyeDir(uv);
  let n = sampleCount(reach);
  let spacing = sqrt(PI * reach * reach / f32(n));
  let sampleArea = PI * reach * reach / f32(n);
  var sum = vec3<f32>(0.0);
  var wsum = 0.0;
  var coverage = 0.0;

  // Cakram piksel ini sendiri menutupinya penuh, berapa pun jangkauan tile.
  let cc = textureLoad(gridTex, vec2<i32>(gid.xy), 0).a;
  if (cc < -GRID_MIN_RADIUS) {
    let r = -cc;
    let w = 1.0 / (PI * r * r);
    sum += textureSampleLevel(gridTex, gridSampler, uv, sampleLod(spacing, r)).rgb * w;
    wsum += w;
    coverage = clamp(r - GRID_MIN_RADIUS, 0.0, 1.0);
  }

  for (var k = 0; k < MAX_SAMPLES; k = k + 1) {
    if (k >= n) {
      break;
    }
    let o = vogel(k, n) * reach;
    let suv = uv + o * texel;
    let cs = gridCoc(suv);
    if (cs >= -GRID_MIN_RADIUS) {
      continue;
    }
    let r = -cs;
    let cov = clamp(apertureEdge(-o, r, ce.xy, ce.z) + 0.5, 0.0, 1.0);
    if (cov <= 0.0) {
      continue;
    }
    let w = cov / (PI * r * r);
    sum += textureSampleLevel(gridTex, gridSampler, suv, sampleLod(spacing, r)).rgb * w;
    wsum += w;
    coverage += cov * sampleArea / (PI * r * r);
  }
  // Premultiplied, supaya tenda upsample bisa merata-ratakannya melintasi tepi.
  let a = clamp(coverage, 0.0, 1.0);
  let value = select(vec4<f32>(0.0), vec4<f32>(sum / max(wsum, 1.0e-30) * a, a), wsum > 0.0);
  textureStore(nearOut, vec2<i32>(gid.xy), value);
}

// --- 7. combine: kembali ke resolusi penuh ----------------------------------

@group(0) @binding(14) var farTex: texture_2d<f32>;
@group(0) @binding(15) var nearTex: texture_2d<f32>;
@group(0) @binding(16) var<storage, read_write> outImage: array<vec4<f32>>;

fn sceneBilinear(p: vec2<f32>) -> vec3<f32> {
  let size = vec2<f32>(lens.fullSize);
  let q = clamp(p - 0.5, vec2<f32>(0.0), size - 1.0);
  let q0 = vec2<u32>(floor(q));
  let q1 = min(q0 + 1u, lens.fullSize - 1u);
  let t = q - vec2<f32>(q0);
  let W = lens.fullSize.x;
  let a = mix(scene[q0.y * W + q0.x].rgb, scene[q0.y * W + q1.x].rgb, t.x);
  let b = mix(scene[q1.y * W + q0.x].rgb, scene[q1.y * W + q1.x].rgb, t.x);
  return mix(a, b, t.y);
}

// Cakram seragam radius r px render, tap bilinear pada spiral emas.
fn smallDisc(p: vec2<f32>, r: f32) -> vec3<f32> {
  var sum = vec3<f32>(0.0);
  for (var k = 0; k < SMALL_TAPS; k = k + 1) {
    let rho = sqrt((f32(k) + 0.5) / f32(SMALL_TAPS));
    let th = f32(k) * GOLDEN_ANGLE;
    sum += sceneBilinear(p + rho * r * vec2<f32>(cos(th), sin(th)));
  }
  return sum / f32(SMALL_TAPS);
}

fn tent(t: texture_2d<f32>, uv: vec2<f32>) -> vec4<f32> {
  let h = 0.5 / vec2<f32>(textureDimensions(t));
  return 0.25 * (textureSampleLevel(t, gridSampler, uv + vec2<f32>(-h.x, -h.y), 0.0)
               + textureSampleLevel(t, gridSampler, uv + vec2<f32>(h.x, -h.y), 0.0)
               + textureSampleLevel(t, gridSampler, uv + vec2<f32>(-h.x, h.y), 0.0)
               + textureSampleLevel(t, gridSampler, uv + vec2<f32>(h.x, h.y), 0.0));
}

// Warna satu lapis berjari-jari CoC r (px render): tajam, cakram kecil di
// resolusi penuh, atau medan jauh grid untuk blur besar.
fn layerColor(p: vec2<f32>, uv: vec2<f32>, sharp: vec3<f32>, r: f32) -> vec3<f32> {
  // Ambang grid, px render.
  let cell = GRID_MIN_RADIUS / lens.gridScale;
  var base = sharp;
  if (r >= 0.5) {
    base = smallDisc(p, min(r, 2.0 * cell));
  }
  let blend = smoothstep(cell, 2.0 * cell, r);
  if (blend > 0.0) {
    base = mix(base, tent(farTex, uv).rgb, blend);
  }
  return base;
}

@compute @workgroup_size(8, 8, 1)
fn combine(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= lens.fullSize.x || gid.y >= lens.fullSize.y) {
    return;
  }
  let index = gid.y * lens.fullSize.x + gid.x;
  let source = scene[index];
  let p = vec2<f32>(gid.xy) + 0.5;
  let uv = p / vec2<f32>(lens.fullSize);
  let front = signedCoc(depthAt(uv));
  var base = layerColor(p, uv, source.rgb, abs(front) * 0.5);
  // Dua lapis: latar blur tembus di sela helai lapis depan.
  let a = alphaAt(uv);
  if (a < 1.0 && front >= -NEAR_LAYER_PX) {
    let back = layerColor(p, uv, source.rgb, abs(signedCoc(planeAt(uv, 1u))) * 0.5);
    base = mix(back, base, a);
  }
  let nearValue = tent(nearTex, uv);
  if (nearValue.a > 0.0) {
    base = max(base * (1.0 - nearValue.a) + nearValue.rgb, vec3<f32>(0.0));
  }
  outImage[index] = vec4<f32>(base, source.a);
}
