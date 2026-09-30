// Transliterasi $SPEKTRAFILM_OFX/shaders/vulkan/SpektraFilmExposure.comp
// (263 baris, binding 0,1,4-9) ke WGSL, dengan enam binding hulu (4-9)
// dikepak menjadi tiga arena (Task 8): `staticArena` (inputToSrgb,
// colorDecodeLuts, colorTransferKinds -- dibuktikan stock-invariant di
// host/spectral.ts), `stockArena` (inputToReferenceXyz, mallettRawMatrix --
// dibuktikan stock-dependent), `dynamicArena` (hanatosRawResponse, dihitung
// host/spectral.ts dari data stock terpilih). Tahap ini menulis tap
// `log_e_film` (Task 11).
//
// Konstanta arena (ARENA_<NAMA>_OFFSET) disambung DI DEPAN berkas ini oleh
// filmExposure.ts, lewat `arena.wgslConstants()` -- lihat pola yang sama di
// materializeActiveRegion.ts (Task 9). CORE_PARAMS_WGSL disambung sebelum
// itu.
//
// KONVENSI MATRIKS (diperiksa lebih dulu, sesuai peringatan brief): setiap
// matriks 3x3 di sini (inputToSrgb, inputToReferenceXyz, mallettRawMatrix)
// disimpan ROW-MAJOR di host (host/spectral.ts dan bake_web_assets.py Task
// 4, meniru tata letak hulu `SpektraVulkanRenderer.cpp`) -- baris i dibaca
// dari offset `i*3`, dan hasil `output[i] = row_i . input`. Fungsi
// `multiplyMatrix3` di bawah membaca persis pola itu (elemen 0,1,2 = baris
// 0 dst), SAMA dengan `multiplyInputToSrgb`/`multiplyInputToReferenceXyz`
// GLSL hulu. Ini BUKAN `matNxN * vec` bawaan WGSL (yang column-major) --
// dilakukan manual lewat pembacaan array float, jadi konvensi baris/kolom
// bawaan bahasa tidak relevan di sini.

@group(0) @binding(0) var<storage, read> src: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> filmRaw: array<vec4<f32>>;
@group(0) @binding(2) var<uniform> params: CoreParams;
@group(0) @binding(3) var<storage, read> staticArena: array<f32>;
@group(0) @binding(4) var<storage, read> stockArena: array<f32>;
@group(0) @binding(5) var<storage, read> dynamicArena: array<f32>;
// Fase 2C Task 9: x = pengali nilai TER-ENCODE sebelum decode CCTF
// (`2**autoexposure_ev` -- Python `FilmingStage.auto_exposure` mengalikan
// gambar input APA ADANYA, sebelum `rgb_to_raw` men-decode). 1 bila decode mati
// (auto-exposure lalu ikut `filmExposureEv`, setara karena linear).
@group(0) @binding(6) var<uniform> inputFrame: vec4<f32>;

// "Camera Raw" (ekstensi DICHROIC di luar spektrafilm, `host/cameraDevelop.ts`):
// white balance (3x3 di primer input), tone luminans di sekitar pivot, lalu
// saturasi. `flags.z == 0` -> DILEWATI persis (nilai netral), jadi gerbang
// parity Python tidak tersentuh.
struct CameraFrame {
  wb0: vec4<f32>,
  wb1: vec4<f32>,
  wb2: vec4<f32>,
  // xyz = bobot luminans ternormalisasi, w = pivot
  luma: vec4<f32>,
  // x = pengali contrast, y = highlights, z = shadows, w = whites
  tone: vec4<f32>,
  // x = blacks, y = saturasi, z = aktif (1/0), w = 2^cameraExposureEv
  flags: vec4<f32>,
}
@group(0) @binding(7) var<uniform> cameraFrame: CameraFrame;

const kLog10E: f32 = 0.4342944819032518;
const kColorAdaptationInputCompression: u32 = 1u << 0u;
// Fase 2C Task 9: `io.input_cctf_decoding` Python (`FLAG_INPUT_CCTF_DECODING`, params.ts).
const kInputCctfDecoding: u32 = 1u << 4u;

fn colorSpaceIndex() -> u32 {
  return u32(clamp(params.inputColorSpace, 0, i32(max(params.colorSpaceCount, 1u)) - 1));
}

fn colorAdaptationEnabled(flag: u32) -> bool {
  return (params.slot1 & flag) != 0u;
}

fn sampleDecodeLut(value: f32, colorSpace: u32) -> f32 {
  let lutSize = max(params.transferLutSize, 2u);
  let decodeMin = params.colorDecodeMin;
  let decodeMax = params.colorDecodeMax;
  let range = max(decodeMax - decodeMin, 1.0e-6);
  let step = range / f32(lutSize - 1u);
  let offset = ARENA_COLORDECODELUTS_OFFSET + colorSpace * lutSize;
  if (value <= decodeMin) {
    let y0 = staticArena[offset];
    let y1 = staticArena[offset + 1u];
    return y0 + (value - decodeMin) * ((y1 - y0) / max(step, 1.0e-12));
  }
  if (value >= decodeMax) {
    let y0 = staticArena[offset + lutSize - 2u];
    let y1 = staticArena[offset + lutSize - 1u];
    return y1 + (value - decodeMax) * ((y1 - y0) / max(step, 1.0e-12));
  }
  let position = ((value - decodeMin) / range) * f32(lutSize - 1u);
  let lo = u32(floor(position));
  let hi = min(lo + 1u, lutSize - 1u);
  let t = position - f32(lo);
  return mix(staticArena[offset + lo], staticArena[offset + hi], t);
}

// PENYIMPANGAN DARI GLSL HULU, DIBUKTIKAN NUMERIK -- baca sebelum mengubah.
//
// GLSL hulu (`decodeInputRgb`, SpektraFilmExposure.comp:110-119) mendekode
// TANPA SYARAT lain selain `colorTransferKinds[colorSpace] != 0u` -- tidak
// ada flag "apply cctf decoding" terpisah di blok push-constant manapun.
// Untuk stock kodak_portra_400 + colorSpace "ProPhoto RGB" (indeks 19),
// `colorTransferKinds[19] == 4` (bukan 0), jadi transliterasi literal GLSL
// akan SELALU mendekode di sini.
//
// Python hulu (`FilmingStage._rgb_to_film_raw` ->
// `rgb_to_raw_hanatos2025(..., apply_cctf_decoding=self._io.input_cctf_decoding)`,
// dan `io.input_cctf_decoding` default `False`, TIDAK disentuh
// `digest_params` untuk konfigurasi manapun yang relevan di sini) TIDAK
// PERNAH mendekode untuk kombinasi (color_space="ProPhoto RGB",
// input_cctf_decoding=False) yang dipakai `gen_reference.py`. CoreParams
// tidak punya slot untuk flag independen ini -- desain hulu mengasumsikan
// "kolom warna dipilih user" MENENTUKAN decode-atau-tidak (setiap entri di
// 26 colorSpaces punya `colorTransferKinds` tetap), sementara Python
// mengekspos `apply_cctf_decoding` sebagai sumbu ORTOGONAL terhadap nama
// color space. Kombinasi test (ProPhoto RGB + decode OFF) tidak
// punya representasi dalam ruang parameter shader ini sama sekali.
//
// DIBUKTIKAN, bukan diasumsikan (lih. task-11-report.md untuk transkrip
// lengkap) -- pada pixel gray_ramp yang sama, terhadap fixture
// `log_e_film.f32`, setelah jendela erf4 (bukan tabel arsip) sudah benar:
//   - TANPA decode di sini : galat log10 ~3e-5 (dalam orde noise f32/f64).
//   - DENGAN decode di sini: galat log10 ~1.2 (bukan struktural kecil --
//     off by lebih dari satu stop) karena kurva decode ProPhoto (gamma
//     ~1.8) MENGUBAH NILAI SUBSTANSIAL (0.5 -> 0.287 dkk), sementara Python
//     memang tidak pernah menyentuhnya untuk kombinasi ini.
//
// FASE 2C TASK 9: flag independen itu kini ada -- `kInputCctfDecoding` (bit 4
// `slot1`, dari `RenderParams.inputCctfDecoding`), BUKAN `colorTransferKinds`.
// Mati: identitas (perilaku yang dibuktikan di atas). Hidup: LUT decode
// label ini, pada nilai ter-encode yang lebih dulu dikalikan `inputFrame.x`
// (auto-exposure Python bekerja di ruang ter-encode). Decode OFX identik
// dengan `cctf_decoding` colour untuk 20 label (diukur, selisih 0);
// `validateInputColorSpace` (plan.ts) menolak decode untuk 6 sisanya.
fn decodeInputRgb(rgb: vec3<f32>, colorSpace: u32) -> vec3<f32> {
  if (!colorAdaptationEnabled(kInputCctfDecoding)) {
    return rgb;
  }
  let scaled = rgb * inputFrame.x;
  return vec3<f32>(
    sampleDecodeLut(scaled.r, colorSpace),
    sampleDecodeLut(scaled.g, colorSpace),
    sampleDecodeLut(scaled.b, colorSpace),
  );
}

fn logistic(x: f32) -> f32 {
  return 1.0 / (1.0 + exp(-x));
}

// Port `developLuma` (host/cameraDevelop.ts): stop di atas pivot, dikali
// contrast, lalu empat masker logistik (sisi gelap dalam bentuk cermin).
fn developLuma(y: f32) -> f32 {
  let pivot = cameraFrame.luma.w;
  let l = log2(max(y, 1.0e-7) / pivot);
  var t = l * cameraFrame.tone.x;
  t += cameraFrame.tone.y * logistic(t - 1.5);
  t += cameraFrame.tone.z * logistic(-1.5 - t);
  t += cameraFrame.tone.w * logistic(t - 4.0);
  t += cameraFrame.flags.x * logistic(-4.0 - t);
  return pivot * exp2(t);
}

fn cameraDevelop(rgb: vec3<f32>) -> vec3<f32> {
  if (cameraFrame.flags.z == 0.0) {
    return rgb;
  }
  let c = vec3<f32>(dot(cameraFrame.wb0.xyz, rgb), dot(cameraFrame.wb1.xyz, rgb), dot(cameraFrame.wb2.xyz, rgb));
  let y = dot(cameraFrame.luma.xyz, c);
  let yOut = developLuma(y);
  let gain = yOut / max(y, 1.0e-7);
  return max(vec3<f32>(yOut) + cameraFrame.flags.y * (c * gain - vec3<f32>(yOut)), vec3<f32>(0.0)) * cameraFrame.flags.w;
}

// Baca satu matriks 3x3 row-major dari `arena` mulai `base`, kalikan `rgb`.
// `arena[base+0..2]` = baris 0, `arena[base+3..5]` = baris 1, dst -- lihat
// catatan konvensi di atas berkas ini.
fn multiplyMatrix3(arena: u32, base: u32, colorSpace: u32, rgb: vec3<f32>) -> vec3<f32> {
  let o = base + colorSpace * 9u;
  if (arena == 0u) {
    return vec3<f32>(
      staticArena[o] * rgb.r + staticArena[o + 1u] * rgb.g + staticArena[o + 2u] * rgb.b,
      staticArena[o + 3u] * rgb.r + staticArena[o + 4u] * rgb.g + staticArena[o + 5u] * rgb.b,
      staticArena[o + 6u] * rgb.r + staticArena[o + 7u] * rgb.g + staticArena[o + 8u] * rgb.b,
    );
  }
  return vec3<f32>(
    stockArena[o] * rgb.r + stockArena[o + 1u] * rgb.g + stockArena[o + 2u] * rgb.b,
    stockArena[o + 3u] * rgb.r + stockArena[o + 4u] * rgb.g + stockArena[o + 5u] * rgb.b,
    stockArena[o + 6u] * rgb.r + stockArena[o + 7u] * rgb.g + stockArena[o + 8u] * rgb.b,
  );
}

fn mallettRaw(linearSrgb: vec3<f32>) -> vec3<f32> {
  let srgb = max(linearSrgb, vec3<f32>(0.0));
  let o = ARENA_MALLETTRAWMATRIX_OFFSET;
  return vec3<f32>(
    stockArena[o] * srgb.r + stockArena[o + 1u] * srgb.g + stockArena[o + 2u] * srgb.b,
    stockArena[o + 3u] * srgb.r + stockArena[o + 4u] * srgb.g + stockArena[o + 5u] * srgb.b,
    stockArena[o + 6u] * srgb.r + stockArena[o + 7u] * srgb.g + stockArena[o + 8u] * srgb.b,
  );
}

fn mitchellWeight(t: f32) -> f32 {
  let B = 1.0 / 3.0;
  let C = 1.0 / 3.0;
  let x = abs(t);
  if (x < 1.0) {
    return (1.0 / 6.0) * ((12.0 - 9.0 * B - 6.0 * C) * x * x * x +
                          (-18.0 + 12.0 * B + 6.0 * C) * x * x +
                          (6.0 - 2.0 * B));
  }
  if (x < 2.0) {
    return (1.0 / 6.0) * ((-B - 6.0 * C) * x * x * x +
                          (6.0 * B + 30.0 * C) * x * x +
                          (-12.0 * B - 48.0 * C) * x +
                          (8.0 * B + 24.0 * C));
  }
  return 0.0;
}

fn safeIndex(index: i32, size: u32) -> u32 {
  if (size <= 1u) {
    return 0u;
  }
  let period = i32(size) * 2 - 2;
  var mirrored = index % period;
  if (mirrored < 0) {
    mirrored += period;
  }
  if (mirrored >= i32(size)) {
    mirrored = period - mirrored;
  }
  return u32(mirrored);
}

// `responseOffset` dalam TEXEL (vec4), bukan float -- konversi ke offset
// float terjadi di titik baca (`base + idx*4u`), sama seperti Task 11 Step 5
// mengepak (r,g,b,0) per texel di host/spectral.ts::packVec4Pair.
fn sampleHanatosTexel(responseOffsetTexels: u32, xi: u32, yj: u32) -> vec3<f32> {
  let texelIndex = responseOffsetTexels + xi * params.hanatosHeight + yj;
  let o = ARENA_HANATOSRAWRESPONSE_OFFSET + texelIndex * 4u;
  return vec3<f32>(dynamicArena[o], dynamicArena[o + 1u], dynamicArena[o + 2u]);
}

fn hanatosRaw(xyz: vec3<f32>) -> vec3<f32> {
  if (params.hanatosWidth < 2u || params.hanatosHeight < 2u) {
    return vec3<f32>(0.0);
  }

  let b = xyz.x + xyz.y + xyz.z;
  let xy = clamp(xyz.xy / max(b, 1.0e-10), vec2<f32>(0.0), vec2<f32>(1.0));
  let tx = clamp((1.0 - xy.x) * (1.0 - xy.x), 0.0, 1.0);
  let ty = clamp(xy.y / max(1.0 - xy.x, 1.0e-10), 0.0, 1.0);
  let xCoord = tx * f32(params.hanatosWidth - 1u);
  let yCoord = ty * f32(params.hanatosHeight - 1u);
  let xBase = select(i32(floor(xCoord)), i32(params.hanatosWidth - 2u), xCoord >= f32(params.hanatosWidth - 1u));
  let yBase = select(i32(floor(yCoord)), i32(params.hanatosHeight - 2u), yCoord >= f32(params.hanatosHeight - 1u));
  let xFrac = select(xCoord - f32(xBase), 1.0, xCoord >= f32(params.hanatosWidth - 1u));
  let yFrac = select(yCoord - f32(yBase), 1.0, yCoord >= f32(params.hanatosHeight - 1u));

  var wx: array<f32, 4> = array<f32, 4>(
    mitchellWeight(xFrac + 1.0),
    mitchellWeight(xFrac),
    mitchellWeight(xFrac - 1.0),
    mitchellWeight(xFrac - 2.0),
  );
  var wy: array<f32, 4> = array<f32, 4>(
    mitchellWeight(yFrac + 1.0),
    mitchellWeight(yFrac),
    mitchellWeight(yFrac - 1.0),
    mitchellWeight(yFrac - 2.0),
  );

  var raw = vec3<f32>(0.0);
  var weightSum = 0.0;
  let responseOffsetTexels = select(0u, params.hanatosWidth * params.hanatosHeight, colorAdaptationEnabled(kColorAdaptationInputCompression));
  for (var i: u32 = 0u; i < 4u; i = i + 1u) {
    let xi = safeIndex(xBase - 1 + i32(i), params.hanatosWidth);
    for (var j: u32 = 0u; j < 4u; j = j + 1u) {
      let yj = safeIndex(yBase - 1 + i32(j), params.hanatosHeight);
      let weight = wx[i] * wy[j];
      weightSum += weight;
      raw += weight * sampleHanatosTexel(responseOffsetTexels, xi, yj);
    }
  }
  if (weightSum != 0.0) {
    raw /= weightSum;
  }
  return raw * max(b, 0.0);
}

@compute @workgroup_size(32, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let activeWidth = select(params.activeWidth, params.width, params.activeWidth == 0u);
  let activeHeight = select(params.activeHeight, params.height, params.activeHeight == 0u);
  if (gid.x >= activeWidth || gid.y >= activeHeight) {
    return;
  }

  let absoluteGid = gid.xy + vec2<u32>(params.activeOriginX, params.activeOriginY);
  if (absoluteGid.x >= params.width || absoluteGid.y >= params.height) {
    return;
  }
  let index = absoluteGid.y * params.width + absoluteGid.x;

  // Review seluruh-branch, agenda #5 (`docs/superpowers/plans/2026-09-11-
  // dichroic-phase1-engine.md`): sampai commit ini, di sini ada cabang
  // `select(index, tileGid berbasis fullWidth/fullHeight, params.slot2==1u)`
  // -- port literal `_pad2`/"selektor source-index" hulu (spec §4.3,
  // task-7-brief.md), didokumentasikan `test/parity/params.ts` sebagai
  // "0: sampel dari indeks lokal (bukan buffer tetangga resolusi-penuh) --
  // tidak ada tiling di gerbang Task 11". Diaudit di sini karena TIDAK ADA
  // pemanggil TypeScript manapun (`filmExposure.ts`, atau CoreParams
  // manapun yang `test/parity/params.ts` bangun) yang PERNAH menyetel
  // `slot2=1` untuk tahap ini -- cabang itu 100% mati sejak ditulis.
  // Bahaya diamnya BUKAN kosmetik: `src` di tahap ini SELALU buffer
  // ping-pong LOKAL tile (`ctx.source`, `params.width x params.height`,
  // TIDAK ADA buffer kedua berresolusi-penuh yang dibind di sini sama
  // sekali -- lih. daftar binding di atas), sementara cabang mati itu
  // menghitung indeks dengan STRIDE `fullWidth`/`fullHeight` (dimensi
  // gambar PENUH, Task 19). Begitu Task 19 (tiling) ada dan `fullWidth !=
  // params.width`, andai `slot2=1` disetel (bukan mustahil -- `slot2`
  // adalah field publik `CoreParams`, dapat disetel pemanggil manapun),
  // `sourceIndex` akan membaca piksel yang SALAH secara diam-diam dan
  // deterministik (row-wrap ke stride yang beda dari buffer sebenarnya)
  // untuk tile mana pun yang indeksnya kebetulan masih pas di dalam
  // panjang buffer -- persis kelas bug yang agenda #5 minta diperiksa di
  // kesembilan tahap ("penalaran guard 2 Task 9 diwarisi tahap dengan
  // indeks sumber/tujuan BERBEDA"). Dihapus di sini (bukan diberi test
  // yang mendorong cabang mati ini) karena satu-satunya perbaikan yang
  // tidak menyimpang dari kontrak: cabang ini tidak bisa dibuat AMAN tanpa
  // mem-bind buffer kedua yang tidak pernah ada. `slot2` TETAP di
  // `CoreParams` (kontrak 26-field bersama delapan shader lain, Task 7) --
  // hanya penggunaannya DI SINI yang dihapus. Nol perubahan perilaku:
  // setiap pemanggil yang ada SELALU `slot2=0`, jadi `sourceIndex` SELALU
  // `index` sampai perubahan ini.

  let exposure = exp2(params.filmExposureEv);
  let colorSpace = colorSpaceIndex();
  let source = src[index];
  let decoded = cameraDevelop(decodeInputRgb(source.rgb, colorSpace));
  let linearSrgb = multiplyMatrix3(0u, ARENA_INPUTTOSRGB_OFFSET, colorSpace, decoded);
  let referenceXyz = multiplyMatrix3(1u, ARENA_INPUTTOREFERENCEXYZ_OFFSET, colorSpace, decoded);
  let raw = select(hanatosRaw(referenceXyz), mallettRaw(linearSrgb), params.rgbToRawMethod == 1);
  let rgb = max(raw * exposure, vec3<f32>(0.0));

  filmRaw[index] = select(
    vec4<f32>(log(rgb + vec3<f32>(1.0e-10)) * kLog10E, source.a),
    vec4<f32>(rgb, source.a),
    params.slot0 == 1u,
  );
}
