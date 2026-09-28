/**
 * Cerminan blok push-constant `CoreParams` dari shader Vulkan hulu.
 *
 * WebGPU tidak memiliki push constant, jadi blok ini menjadi uniform buffer:
 * satu struct WGSL (`CORE_PARAMS_WGSL`) plus penulis byte (`writeCoreParams`)
 * yang setiap tahap (Task 9 dan seterusnya) panggil sebelum tiap dispatch.
 *
 * Urutan field HARUS sama persis dengan hulu — diverifikasi langsung dari:
 *
 *   sed -n '/layout(push_constant)/,/} params;/p' \
 *     "$SPEKTRAFILM_OFX/shaders/vulkan/SpektraCurveDevelop.comp"
 *
 * dan dicocokkan terhadap tujuh shader lain yang memakai blok identik ini
 * (SpektraDiffusion, SpektraDir, SpektraFilmExposure, SpektraGrain,
 * SpektraHalation, SpektraPrintScan, SpektraScannerPost — total 8 dari 10
 * shader compute hulu; SpektraCopy dan SpektraFormatConvert punya blok push-
 * constant sendiri yang jauh lebih kecil dan tidak dicerminkan di sini).
 * Ke-26 field itu skalar 4-byte semua, jadi tata letak std430 (Vulkan) dan
 * uniform WGSL memberi offset yang identik: 4 byte berurutan per field,
 * total logis 104 byte, dibulatkan ke 112 untuk penyelarasan uniform 16-byte.
 *
 * TIGA FIELD BUKAN PADDING. Upstream menamainya `_pad0`, `_pad1`, `_pad2`,
 * tapi nama itu menyesatkan: host mengisinya ulang tiap dispatch
 * (`SpektraVulkanRenderer.cpp`, lambda `dispatchHalation`, baris ~6272:
 * `_pad0 = operation; _pad1 = sigmaMode; _pad2 = component;`) dan artinya
 * berbeda di tiap shader. Di sini mereka dinamai netral `slot0`/`slot1`/
 * `slot2` — satu nama semantik akan menjadi dusta di sebagian besar tahap.
 * JANGAN menebak makna sebuah slot dari nama field ini; baca blok push-
 * constant shader hulu yang sedang diport, dan baca tempat
 * `SpektraVulkanRenderer.cpp` mengisinya untuk dispatch itu.
 *
 * Pemakaian terverifikasi per shader (bukan sekadar disalin dari catatan
 * perencanaan — dibaca ulang dari source hulu saat menulis file ini):
 *
 * slot0 (upstream `_pad0`):
 *   - Diffusion, Dir, Grain, Halation, ScannerPost: dinamai lokal
 *     `operation` — enum `kOp*` yang memilih cabang kode dalam shader.
 *   - PrintScan: tetap `_pad0`; enum `kPrintScanOp*`, peran sama.
 *   - FilmExposure: tetap `_pad0`; flag boolean (`== 1u`) yang memilih
 *     penyimpanan raw linear vs log.
 *   - CurveDevelop: dideklarasikan tapi tidak dibaca di shader ini.
 *
 * slot1 (upstream `_pad1`):
 *   - CurveDevelop, FilmExposure: bitfield colour-adaptation
 *     (`kColorAdaptationCurveSmoothing = 1u << 1u`, lihat
 *     `FLAG_COLOR_ADAPTATION_CURVE_SMOOTHING` di bawah; FilmExposure juga
 *     memakai bit 0 untuk `kColorAdaptationInputCompression`).
 *   - Diffusion, Dir: dinamai lokal `componentIndex`/`component` — memilih
 *     komponen spektral yang diproses dispatch ini.
 *   - Halation: dinamai lokal `sigmaMode` — memilih varian radius/bobot
 *     blur (`kSigmaScatterCore`/`kSigmaScatterTail`/`kSigmaBounce`), atau
 *     jumlah chunk pada varian dispatch 1D-nya.
 *   - Grain, PrintScan: tetap `_pad1`; PrintScan memakainya sebagai flag
 *     boolean "defer output encode", Grain tidak membacanya.
 *   - ScannerPost (Task 18 Gate B, ditambahkan setelah paragraf di atas
 *     ditulis): bit 2 (`FLAG_GLARE_ACTIVE` di bawah) menandai
 *     `print_render.glare.active` Python -- bit 0/1 TIDAK dibaca shader
 *     ini (aman berbagi field dengan CurveDevelop/FilmExposure di atas:
 *     `(slot1 & 4u)` tidak terpengaruh bit 0/1 manapun).
 *
 *   PERBAIKAN dari draf tugas ini sebelumnya: draf menyatakan slot1 dipakai
 *   sebagai `sigmaMode` pada Diffusion. Itu keliru — `sigmaMode` adalah
 *   nama Halation; slot1 Diffusion bernama `componentIndex`. Dikoreksi di
 *   sini setelah membaca ulang SpektraDiffusion.comp dan SpektraHalation.comp
 *   langsung serta baris dispatch di SpektraVulkanRenderer.cpp.
 *
 * slot2 (upstream `_pad2`):
 *   - Diffusion: nilai ter-pack `(downsampleScale << 16) | groupCount`,
 *     dibongkar lewat `groupCountFromPacked`/`downsampleScaleFromPacked`.
 *   - FilmExposure: TIDAK LAGI dibaca `filmExposure.wgsl` (review
 *     seluruh-branch agenda #5, ../../docs/superpowers/plans/2026-09-11-
 *     dichroic-phase1-engine.md) -- dulu `_pad2 == 1u` memilih pengambilan
 *     sampel dari "buffer tetangga resolusi-penuh" (selektor source-index,
 *     makna upstream), tapi cabang itu 100% mati (tidak ada pemanggil TS
 *     yang pernah menyetel `slot2=1` untuk tahap ini) DAN berbahaya kalau
 *     suatu hari disetel (`src` di tahap ini SELALU buffer ping-pong lokal
 *     tile, tidak pernah ada buffer resolusi-penuh kedua yang dibind --
 *     cabang itu akan diam-diam membaca piksel salah di bawah tiling Task
 *     19). Dihapus dari WGSL; field tetap ada di struct (kontrak Task 7)
 *     tapi FilmExposure tidak menafsirkannya lagi.
 *   - Halation: dinamai lokal `component` — selektor komponen spektral,
 *     terpisah dari `sigmaMode` (slot1) shader yang sama.
 *   - Dir, Grain, PrintScan, ScannerPost: tetap `_pad2`, tidak dibaca di
 *     shader-shader ini pada revisi hulu saat ini.
 */

/**
 * Bit 1 dari slot1. Dipakai sebagai bitfield colour-adaptation pada
 * CurveDevelop dan FilmExposure (`kColorAdaptationCurveSmoothing` hulu).
 * Konstanta ini TIDAK berlaku untuk slot1 di Diffusion (di sana slot1 adalah
 * componentIndex, bukan bitfield) atau di Halation (di sana slot1 adalah
 * sigmaMode) — lihat catatan per-slot di atas sebelum memakainya di tahap
 * baru.
 */
export const FLAG_COLOR_ADAPTATION_CURVE_SMOOTHING = 1 << 1;

/**
 * Bit 0 dari slot1. Dipakai HANYA oleh FilmExposure (`kColorAdaptationInputCompression`
 * hulu) untuk memilih separuh mana dari `HanatosRawResponse` (Task 11) yang
 * dibaca -- separuh pertama (offset 0) adalah tabel mentah, separuh kedua
 * (offset `hanatosWidth*hanatosHeight`) adalah versi yang direstriksi ke
 * gamut input (`remapHanatosResponseForInputGamutCompression` hulu). Bit ini
 * TIDAK berlaku untuk slot1 di CurveDevelop (di sana slot1 dipakai
 * FLAG_COLOR_ADAPTATION_CURVE_SMOOTHING, bit 1) atau di shader lain -- lihat
 * catatan per-slot di atas.
 */
export const FLAG_COLOR_ADAPTATION_INPUT_COMPRESSION = 1 << 0;

/**
 * Bit 2 dari slot1. Dipakai HANYA oleh ScannerPost (Task 18 Gate B,
 * `add_glare` / `model/glare.py`) untuk mencerminkan `print_render.glare.
 * active` Python: menyala untuk keluarga fixture `_stochastic`
 * (default hulu, glare aktif), padam untuk `_lut` (`lut_mode` memaksa
 * `deactivate_stochastic_effects=True` -> `glare.active=False`,
 * `params_builder.py::digest_params`). TIDAK berlaku di shader lain mana
 * pun (bit 0/1 dipakai FilmExposure/CurveDevelop, lih. catatan per-slot di
 * atas) -- `scannerPost.wgsl` HANYA memeriksa bit ini, tidak pernah bit 0/1.
 */
export const FLAG_GLARE_ACTIVE = 1 << 2;

/**
 * Bit 3 dari slot1 (Task 18c). Dipakai HANYA oleh ScannerPost untuk
 * mencerminkan `scanner.unsharp_mask != (0,0)` Python
 * (`_apply_blur_and_unsharp`, `scanning.py:123-128`): menyala untuk
 * `family: 'measured'` (default hulu `unsharp_mask=(0.7,0.7)`, TIDAK
 * disentuh `deactivate_stochastic_effects` -- BEDA dari `FLAG_GLARE_
 * ACTIVE` di atas, bit ini TIDAK bergantung grain/glare, hanya pada
 * `lut_mode`/`deactivate_spatial_effects`), padam untuk `'lut'`
 * (`lut_mode` memaksa `scanner.unsharp_mask=(0,0)`,
 * `params_builder.py::digest_params`). Jadi berbeda dari `FLAG_GLARE_
 * ACTIVE`: menyala untuk `family: 'measured'` REGARDLESS keluarga
 * `_stochastic` atau `<case>` biasa -- keduanya sama-sama TIDAK
 * mempromosikan `deactivate_spatial_effects`. TIDAK berlaku di shader
 * lain mana pun.
 */
export const FLAG_UNSHARP_ACTIVE = 1 << 3;

/**
 * TIGA RUANG KOORDINAT BERBEDA hidup berdampingan di `CoreParams`, dan
 * kedelapan tahap Task 11-18 (plus tahap `materializeActiveRegion` yang
 * membangun `rgb_in`, Task 9) membaca ketiganya lewat konstanta ini —
 * bukan lewat komentar shader satu per satu. Dipatok di sini, satu kali,
 * dengan rujukan baris hulu yang bisa diverifikasi ulang siapa pun, karena
 * salah menyamakan salah satu dari tiga ini adalah cara paling murah untuk
 * menghasilkan "gambar yang salah secara masuk akal" tanpa galat apa pun —
 * persis kelas bug yang `arena.ts` dan modul ini sendiri sudah waspadai
 * untuk kasus lain (offset arena, urutan field).
 *
 *   - `width`/`height` — dimensi BUFFER YANG SEDANG DIPROSES (satu tile,
 *     TERMASUK apron bila ada). Ini adalah STRIDE pengindeksan linear:
 *     `index = gid.y * params.width + gid.x`. Sumber dan tujuan berbagi
 *     stride yang sama dalam satu dispatch.
 *   - `activeOriginX/Y`, `activeWidth/Height` — sub-rektangel DI DALAM
 *     buffer itu yang benar-benar ditulis dispatch ini (pusat tile, TANPA
 *     apron). `activeWidth == 0u` (dan sama untuk height) berarti "seluruh
 *     buffer" — bukan "nol piksel" — persis pola
 *     `SpektraCurveDevelop.comp:231-232` dan `SpektraFilmExposure.comp:232-
 *     233` (`params.activeWidth == 0u ? params.width : params.activeWidth`).
 *     Kedua shader itu JUGA memeriksa batas DUA KALI: sekali terhadap ukuran
 *     aktif efektif (SEBELUM origin ditambahkan — `SpektraCurveDevelop.
 *     comp:233`, `SpektraFilmExposure.comp:234`), sekali lagi terhadap
 *     `width`/`height` (SETELAH origin ditambahkan — `SpektraCurveDevelop.
 *     comp:238`, `SpektraFilmExposure.comp:239`). Keduanya setara HANYA
 *     bila `activeOrigin + activeWidth <= width`; pemeriksaan kedua ada
 *     justru untuk pemanggil yang melanggar itu — tanpanya, dispatch
 *     menulis di luar batas buffer secara senyap (WGSL membuangnya tanpa
 *     galat). Setiap tahap yang mengindeks lewat `activeWidth/Height` HARUS
 *     mengadopsi KEDUA pemeriksaan ini, bukan hanya yang pertama.
 *   - `fullWidth`/`fullHeight` — ruang koordinat SELURUH GAMBAR, dipakai
 *     bersama `tileOriginX/Y` untuk memperoleh posisi ABSOLUT pada efek
 *     yang bervariasi spasial (mis. jatuhnya halation dari tepi frame,
 *     bukan tepi tile) — lih. `SpektraFilmExposure.comp` sekitar baris 242
 *     (`absoluteGid = gid + tileOrigin`, lalu `fullWidth`/`fullHeight`
 *     dipakai untuk menormalisasi posisi itu). TIDAK dipakai untuk
 *     pengindeksan buffer manapun secara langsung — itu peran `width`/
 *     `height`.
 */
export interface CoreParams {
  /** Stride buffer yang sedang diproses (tile, termasuk apron) — lihat dokumentasi di atas. */
  width: number;
  /** Stride buffer yang sedang diproses (tile, termasuk apron) — lihat dokumentasi di atas. */
  height: number;
  filmExposureEv: number;
  filmGamma: number;
  exposureCount: number;
  inputColorSpace: number;
  rgbToRawMethod: number;
  colorSpaceCount: number;
  transferLutSize: number;
  colorDecodeMin: number;
  colorDecodeMax: number;
  hanatosWidth: number;
  hanatosHeight: number;
  /** Slot serbaguna; arti berbeda per tahap — lihat dokumentasi di atas. */
  slot0: number;
  /** Slot serbaguna; arti berbeda per tahap — lihat dokumentasi di atas. */
  slot1: number;
  /** Slot serbaguna; arti berbeda per tahap — lihat dokumentasi di atas. */
  slot2: number;
  filmPushPullMode: number;
  filmPushPullStops: number;
  /** Ruang koordinat seluruh gambar, dipakai bersama tileOrigin — lihat dokumentasi di atas. */
  fullWidth: number;
  /** Ruang koordinat seluruh gambar, dipakai bersama tileOrigin — lihat dokumentasi di atas. */
  fullHeight: number;
  tileOriginX: number;
  tileOriginY: number;
  /** Origin sub-rektangel aktif DI DALAM buffer (width/height) — lihat dokumentasi di atas. */
  activeOriginX: number;
  /** Origin sub-rektangel aktif DI DALAM buffer (width/height) — lihat dokumentasi di atas. */
  activeOriginY: number;
  /** 0 berarti "seluruh buffer" (width), BUKAN "nol piksel" — lihat dokumentasi di atas. */
  activeWidth: number;
  /** 0 berarti "seluruh buffer" (height), BUKAN "nol piksel" — lihat dokumentasi di atas. */
  activeHeight: number;
}

type Kind = 'u32' | 'i32' | 'f32';

/**
 * Satu-satunya sumber kebenaran urutan/tipe field. `CORE_PARAMS_WGSL` dan
 * `writeCoreParams` keduanya diturunkan dari array ini, jadi WGSL dan
 * penulis byte tidak bisa diam-diam berbeda urutan — mengubah salah satu
 * berarti mengubah keduanya sekaligus. Yang bisa drift adalah interface
 * `CoreParams` di atas jika ada yang menambah/menghapus field di sana tanpa
 * menyentuh array ini; `_assertFieldsCoverAllKeys` di bawah membuat itu
 * gagal kompilasi TypeScript, dan test params.test.ts membangun object
 * literal yang harus memenuhi `CoreParams` persis (properti hilang/lebih
 * gagal kompilasi) lalu memverifikasi hasil tulisnya field demi field.
 */
const FIELDS = [
  ['width', 'u32'],
  ['height', 'u32'],
  ['filmExposureEv', 'f32'],
  ['filmGamma', 'f32'],
  ['exposureCount', 'u32'],
  ['inputColorSpace', 'i32'],
  ['rgbToRawMethod', 'i32'],
  ['colorSpaceCount', 'u32'],
  ['transferLutSize', 'u32'],
  ['colorDecodeMin', 'f32'],
  ['colorDecodeMax', 'f32'],
  ['hanatosWidth', 'u32'],
  ['hanatosHeight', 'u32'],
  ['slot0', 'u32'],
  ['slot1', 'u32'],
  ['slot2', 'u32'],
  ['filmPushPullMode', 'i32'],
  ['filmPushPullStops', 'f32'],
  ['fullWidth', 'u32'],
  ['fullHeight', 'u32'],
  ['tileOriginX', 'u32'],
  ['tileOriginY', 'u32'],
  ['activeOriginX', 'u32'],
  ['activeOriginY', 'u32'],
  ['activeWidth', 'u32'],
  ['activeHeight', 'u32'],
] as const satisfies ReadonlyArray<readonly [keyof CoreParams, Kind]>;

/**
 * Penjaga waktu-kompilasi: jika `CoreParams` mendapat field baru yang lupa
 * ditambahkan ke `FIELDS`, `keyof CoreParams` tidak lagi menjadi subset dari
 * union nama field di `FIELDS`, dan baris di bawah gagal kompilasi (bukan
 * gagal diam-diam saat runtime). Ini tidak menangkap arah sebaliknya (nama
 * di FIELDS yang bukan keyof CoreParams) — itu sudah ditolak oleh anotasi
 * `satisfies` pada deklarasi FIELDS di atas.
 */
type FieldName = (typeof FIELDS)[number][0];
type AssertFieldsCoverAllKeys = keyof CoreParams extends FieldName
  ? true
  : ['params.ts: FIELDS tidak mencakup semua field CoreParams — perbarui FIELDS di atas'];
const _assertFieldsCoverAllKeys: AssertFieldsCoverAllKeys = true as AssertFieldsCoverAllKeys;
void _assertFieldsCoverAllKeys;

/** Nama field dalam urutan struct, untuk dibandingkan test terhadap hulu. */
export const CORE_PARAMS_FIELD_NAMES: ReadonlyArray<keyof CoreParams> = FIELDS.map(
  ([name]) => name,
);

export const CORE_PARAMS_BYTES = Math.ceil((FIELDS.length * 4) / 16) * 16;

export const CORE_PARAMS_WGSL = `struct CoreParams {
${FIELDS.map(([name, kind]) => `  ${name}: ${kind},`).join('\n')}
}`;

export function writeCoreParams(params: CoreParams, target: ArrayBuffer): void {
  if (target.byteLength < CORE_PARAMS_BYTES) {
    throw new Error(
      `Buffer CoreParams terlalu kecil: ${target.byteLength} < ${CORE_PARAMS_BYTES}`,
    );
  }
  const view = new DataView(target);
  FIELDS.forEach(([name, kind], index) => {
    const offset = index * 4;
    const value = params[name];
    if (kind === 'f32') view.setFloat32(offset, value, true);
    else if (kind === 'i32') view.setInt32(offset, value, true);
    else view.setUint32(offset, value, true);
  });
}
