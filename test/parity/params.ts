/**
 * `defaultCoreParams` -- cerminan params ter-digest Python
 * (`digest_params(init_params())`, `gen_reference.py::_build_params`),
 * BUKAN `init_params()` mentah, dan BUKAN literal 3-argumen dari
 * task-11-brief.md.
 *
 * PENYIMPANGAN DARI TANDA TANGAN BRIEF, DIBUKTIKAN BUKAN DITEBAK:
 *
 * Brief menyatakan `defaultCoreParams(width, height, bundle)`. Itu TIDAK
 * CUKUP -- `CoreParams.filmExposureEv` bukan konstanta statis, ia
 * MENCAKUP hasil auto-exposure metering yang BERGANTUNG PADA ISI GAMBAR
 * (`FilmingStage.auto_exposure`, `camera.auto_exposure` default `True`
 * di `params_schema.py`, TIDAK dimatikan `digest_params` untuk konfigurasi
 * manapun yang relevan di sini). Dibuktikan empiris: `rgb_pre.f32` dan
 * `input.f32` pada ketiga fixture (`gray_ramp`, `log_gray_ramp`,
 * `color_patches`) BUKAN byte-identik -- rasio `rgb_pre/input` KONSTAN per
 * piksel dalam satu gambar (0,354152 untuk gray_ramp, 0,367555 untuk
 * log_gray_ramp, 0,362554 untuk color_patches -- tiga rasio BERBEDA,
 * masing-masing konstan sempurna di semua piksel gambarnya sendiri),
 * persis pola perkalian skalar oleh `2**autoexposure_ev` yang berbeda
 * per gambar. `defaultCoreParams` karena itu menerima `inputRgba` sebagai
 * argumen keempat dan mengukur EV yang sama, di host, sebelum dispatch --
 * meniru apa yang `SpektraVulkanRenderer.cpp::measureAutoExposureEv`
 * lakukan di CPU SEBELUM mengisi `filmExposureEv` (bukan di shader): OFX
 * TIDAK punya tahap GPU terpisah untuk auto-exposure; itu selalu
 * pra-kalkulasi host, sama seperti WGSL port ini.
 *
 * Diverifikasi cocok terhadap rasio di atas untuk ketiga kasus SAMPAI 6+
 * angka signifikan (bukan hanya orde besaran) -- lih. task-11-report.md
 * untuk transkrip lengkap perbandingan `2**ev_terukur` vs rasio
 * `rgb_pre/input` sungguhan.
 */

import { FLAG_GLARE_ACTIVE, FLAG_UNSHARP_ACTIVE } from '../../src/engine/params';
import type { AssetBundle } from '../../src/profiles/load';
import type { CoreParams } from '../../src/engine/params';
import { measureAutoExposureEv } from '../../src/host/autoExposure';

/**
 * `CoreParams` yang mencerminkan `digest_params(init_params())` Python
 * untuk stock `kodak_portra_400` (default `gen_reference.py`/`init_params`)
 * pada tahap FilmExposure. Field yang TIDAK dibaca `filmExposure.wgsl`
 * (`filmGamma`, `filmPushPullMode/Stops`, tiling) diberi nilai netral
 * (tidak berpengaruh, dicatat sebagai demikian) -- bukan ditebak dari nama.
 *
 * Field demi field, dengan sumber:
 *   - `width`/`height`/`fullWidth`/`fullHeight` — dimensi kasus uji (tidak
 *     di-tile, jadi keduanya sama; lih. `params.ts::CoreParams` untuk tiga
 *     ruang koordinat).
 *   - `filmExposureEv` — `camera.exposure_compensation_ev` (0.0, default
 *     `CameraParams`) + `measureAutoExposureEv(...)` (lih. di atas) --
 *     KEDUANYA linear dalam skala raw (`hanatosRaw`/`mallettRaw` linear
 *     terhadap magnitudo input, lih. task-11-report.md), jadi menjumlahkan
 *     keduanya di ruang EV/log2 SETARA dengan menerapkan auto-exposure
 *     sebagai perkalian rgb SEBELUM konversi (yang dilakukan Python) --
 *     dibuktikan, bukan diasumsikan.
 *   - `inputColorSpace` — indeks "ProPhoto RGB" pada
 *     `manifest.colorSpaces.labels` (`io.input_color_space` default).
 *   - `rgbToRawMethod` — 0 (hanatos2025, `settings.rgb_to_raw_method`
 *     default) -- shader memilih mallett hanya bila `== 1`.
 *   - `colorSpaceCount`/`transferLutSize`/`colorDecodeMin`/`colorDecodeMax`
 *     — dari `manifest.colorSpaces` (Task 4), bukan dihardcode ulang.
 *   - `hanatosWidth`/`hanatosHeight` — dari `manifest.hanatos` (Task 4).
 *   - `slot0` — 0: pilih cabang LOG (`_pad0==1u` adalah cabang linear;
 *     tap `log_e_film` butuh log).
 *   - `slot1` — `FLAG_COLOR_ADAPTATION_INPUT_COMPRESSION` (bit 0): Python
 *     `InputGamutCompressSpec.active` default `True`
 *     (`gamut_compression.py:69`), TIDAK dimatikan `digest_params` untuk
 *     konfigurasi ini -- shader harus membaca separuh TERKOMPRESI
 *     `HanatosRawResponse`. Task 18 Gate B menambahkan bit 2
 *     (`FLAG_GLARE_ACTIVE`, `scannerPost.wgsl`-only): menyala untuk
 *     `family: 'measured'`, padam untuk `'lut'` -- lih. `FLAG_GLARE_ACTIVE`
 *     (`src/engine/params.ts`) untuk alasan lengkap.
 *   - `slot2` — 0. `filmExposure.wgsl` tidak lagi membaca field ini
 *     (review seluruh-branch agenda #5 -- cabang "buffer tetangga
 *     resolusi-penuh" yang dulu di sini dihapus sebagai kode mati
 *     berbahaya, bukan diaktifkan oleh tiling Task 19).
 *   - `activeOrigin*`/`tileOrigin*` — 0; `activeWidth/Height` — 0 (berarti
 *     "seluruh buffer", lih. `params.ts`).
 */
/**
 * Keluarga fixture yang menentukan bagaimana `filmExposureEv` dihitung --
 * lih. spec §6.3.3 dan task-11-report.md untuk kenapa ini WAJIB eksplisit,
 * bukan disimpulkan dari nama kasus:
 *
 *   'measured' — `camera.auto_exposure` default `True` Python TIDAK
 *                dimatikan (keluarga `<case>`/`<case>_stochastic`).
 *                `filmExposureEv` = exposureCompensationEv +
 *                `measureAutoExposureEv(...)`, karena EV bergantung isi
 *                gambar (dibuktikan di task-11-report.md, bagian
 *                `defaultCoreParams`). Keluarga ini JUGA satu-satunya yang
 *                efek spasialnya (halation) HIDUP (spec §6.3.2/§6.3.3) --
 *                karena itu `slot0` di bawah dipaksa 1 (`filmExposure.wgsl`
 *                menyimpan raw LINEAR, bukan log) untuk keluarga ini: Task
 *                14 (Halation) butuh raw linear sebelum `log10`-nya
 *                SENDIRI, persis seperti `FilmingStage.expose()` Python
 *                yang menjalankan `apply_halation_um` SEBELUM `log10`. Bila
 *                chain tidak menyertakan `createHalationStage`, tap
 *                `log_e_film` tidak akan pernah tertutup untuk family ini
 *                (`filmExposure.wgsl` sendiri tidak pernah men-log raw-nya).
 *   'lut'      — `debug.lut_mode = True` (keluarga `<case>_lut`).
 *                `params_builder.py:105-107` memaksa `camera.auto_exposure
 *                = False` DAN `camera.exposure_compensation_ev = 0.0` di
 *                bawah `lut_mode` -- `filmExposureEv` HARUS 0, TITIK.
 *                Memanggil `measureAutoExposureEv` di sini akan
 *                menghasilkan angka yang KELIHATAN masuk akal (bergantung
 *                gambar, dalam rentang EV wajar) tapi SALAH, karena Python
 *                tidak pernah menjalankan auto-exposure untuk fixture ini
 *                sama sekali -- persis kesalahan senyap yang harus dicegah
 *                gerbang ini.
 *
 * Tidak ada nilai baku: pemanggil HARUS menyatakan family secara eksplisit.
 * Kombinasi yang salah (mis. family 'measured' dipakai untuk fixture
 * `_lut`, atau sebaliknya) harus gagal keras di `runTapParity`
 * (`test/parity/run.ts`), bukan di sini -- lih. komentar di sana.
 */
export type CoreParamsFamily = 'measured' | 'lut';

export function defaultCoreParams(
  width: number,
  height: number,
  bundle: AssetBundle,
  inputRgba: Float32Array,
  family: CoreParamsFamily,
  /**
   * Task 18c: SEBELUM parameter ini ada, `glareActiveFlag` di bawah
   * disamakan dengan `family === 'measured'` SAJA -- SALAH, dibuktikan oleh
   * gerbang deterministik baru `measuredChain.test.ts` (rgb_out keluarga
   * `<case>` BIASA memerahkan 1.8 max abs error, TIDAK berubah setelah
   * perbaikan DIR terpisah). `CoreParamsFamily` cuma membedakan `lut_mode`
   * dari yang bukan -- ia TIDAK membedakan keluarga fixture dasar `<case>`
   * (`deactivate_stochastic_effects=True`, `tools/gen_reference.py::
   * _build_params(stochastic=False)`, glare DAN grain MATI) dari `<case>_
   * stochastic` (`stochastic=True`, TIDAK memodifikasi `raw`, default hulu
   * `GlareParams.active=True` tetap berlaku) -- KEDUANYA memakai `family:
   * 'measured'` yang SAMA. Pemanggil HARUS menyatakan yang mana secara
   * eksplisit (PERSIS filosofi `family` di atas: tidak ada tebakan diam-diam
   * dari nama), bukan diasumsikan dari `family` saja.
   */
  stochasticEffectsActive: boolean,
  stockId: string = 'kodak_portra_400',
): CoreParams {
  const { colorSpaces } = bundle.manifest;
  const inputColorSpace = colorSpaces.labels.indexOf('ProPhoto RGB');
  if (inputColorSpace < 0) {
    throw new Error('"ProPhoto RGB" tidak ditemukan di manifest.colorSpaces.labels');
  }

  const meterMatrix = bundle.staticTable('inputMeterXyzMatrices');
  const exposureCompensationEv = 0; // CameraParams.exposure_compensation_ev default -- juga dipaksa 0.0 oleh lut_mode, jadi nilai ini benar di KEDUA family.

  let filmExposureEv: number;
  if (family === 'lut') {
    // debug.lut_mode memaksa camera.auto_exposure=False (params_builder.py:106)
    // -- TIDAK ada metering untuk keluarga ini. Sengaja TIDAK memanggil
    // measureAutoExposureEv di cabang ini.
    filmExposureEv = exposureCompensationEv;
  } else if (family === 'measured') {
    const autoExposureEv = measureAutoExposureEv(inputRgba, width, height, meterMatrix, inputColorSpace);
    filmExposureEv = exposureCompensationEv + autoExposureEv;
  } else {
    const exhaustive: never = family;
    throw new Error(`defaultCoreParams: family tidak dikenal: ${String(exhaustive)}`);
  }

  const FLAG_COLOR_ADAPTATION_INPUT_COMPRESSION = 1 << 0;
  // Task 18c (diperbaiki dari Task 18 Gate B, lih. dokumentasi parameter
  // `stochasticEffectsActive` di atas): glare hanya menyala saat KEDUANYA
  // benar -- `family === 'measured'` (`lut_mode` selalu memaksa
  // `glare.active=False`, `params_builder.py::digest_params`) DAN
  // `stochasticEffectsActive` (`deactivate_stochastic_effects` mematikan
  // `print_render.glare.active` untuk keluarga fixture dasar `<case>`,
  // TIDAK untuk `<case>_stochastic`). Hanya `scannerPost.wgsl` yang
  // memeriksa bit ini (lih. `FLAG_GLARE_ACTIVE` untuk kenapa aman berbagi
  // slot1 dengan FilmExposure/CurveDevelop).
  const glareActiveFlag = family === 'measured' && stochasticEffectsActive ? FLAG_GLARE_ACTIVE : 0;
  // Task 18c (`FLAG_UNSHARP_ACTIVE`, `src/engine/params.ts`): BEDA dari
  // glare di atas -- `scanner.unsharp_mask` hanya dinolkan oleh `lut_mode`
  // (`deactivate_spatial_effects`), BUKAN oleh `deactivate_stochastic_
  // effects`. Menyala untuk `family: 'measured'` TERLEPAS dari
  // `stochasticEffectsActive` (keluarga `<case>` biasa MAUPUN
  // `<case>_stochastic` sama-sama TIDAK mempromosikan
  // `deactivate_spatial_effects`).
  const unsharpActiveFlag = family === 'measured' ? FLAG_UNSHARP_ACTIVE : 0;

  return {
    width,
    height,
    filmExposureEv,
    filmGamma: 1, // density_curve_gamma default Python (FilmRenderingParams) -- tidak menyisipkan skala gamma
    // Task 12 (curveDevelop.wgsl): jumlah titik kurva H&D stock ini. Task 11
    // membiarkan ini 0 karena filmExposure.wgsl tidak membacanya --
    // curveDevelop.wgsl MEMBACANYA (batas pencarian biner), jadi WAJIB
    // diisi dari stock yang benar-benar dipakai (lih. brief Task 12).
    exposureCount: bundle.stock(stockId).entry.exposureCount,
    inputColorSpace,
    rgbToRawMethod: 0, // hanatos2025
    colorSpaceCount: colorSpaces.count,
    transferLutSize: colorSpaces.transferLutSize,
    colorDecodeMin: colorSpaces.decodeLutMin,
    colorDecodeMax: colorSpaces.decodeLutMax,
    hanatosWidth: bundle.manifest.hanatos.width,
    hanatosHeight: bundle.manifest.hanatos.height,
    // 'lut': simpan cabang LOG langsung -- `filmExposure.wgsl` sendirian
    // memproduksi `log_e_film` (halation mati di bawah lut_mode). 'measured':
    // simpan cabang LINEAR -- Task 14 (`createHalationStage`) menjalankan
    // scatter + back-reflection ATAS raw linear ini, lalu men-`log10`-kannya
    // sendiri sebagai dispatch terakhirnya. Lih. dokumentasi `CoreParamsFamily`
    // di atas.
    slot0: family === 'lut' ? 0 : 1,
    slot1: FLAG_COLOR_ADAPTATION_INPUT_COMPRESSION | glareActiveFlag | unsharpActiveFlag,
    // 0 -- tetap di CoreParams (kontrak Task 7), tapi filmExposure.wgsl TIDAK
    // LAGI membaca ini (review seluruh-branch agenda #5): cabang
    // "sampel dari buffer tetangga resolusi-penuh" yang dulu ada di sini
    // dihapus, karena tidak pernah dibind buffer keduanya dan `slot2=1`
    // tidak pernah disetel pemanggil manapun -- lih. komentar di
    // filmExposure.wgsl dekat `src[index]` untuk rasional lengkap.
    slot2: 0,
    // 0 -- push/pull mode 0 (tidak aktif). filmExposure.wgsl tidak membaca
    // ini, tapi curveDevelop.wgsl (Task 12) membaca `filmPushPullMode` untuk
    // memilih cabang `experimentalPushPullLogRaw`/`Gain` -- Python
    // (`gen_reference.py`/`digest_params(init_params())`) tidak pernah
    // menyalakan push/pull untuk fixture manapun yang gerbang ini uji, jadi
    // 0 benar untuk KEDUA tahap, bukan hanya "diabaikan" oleh filmExposure.
    filmPushPullMode: 0,
    filmPushPullStops: 0,
    fullWidth: width,
    fullHeight: height,
    tileOriginX: 0,
    tileOriginY: 0,
    activeOriginX: 0,
    activeOriginY: 0,
    activeWidth: 0, // 0 = seluruh buffer
    activeHeight: 0, // 0 = seluruh buffer
  };
}
