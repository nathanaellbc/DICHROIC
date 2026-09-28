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

import { BASELINE_RENDER_PARAMS } from '../../src/params/renderParams';
import type { RenderParams } from '../../src/params/renderParams';
import { buildRenderPlan } from '../../src/params/plan';
import type { AssetBundle } from '../../src/profiles/load';
import type { CoreParams } from '../../src/engine/params';

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

/**
 * Fase 2A Task 3: isi fungsi ini dipindah ke `src/params/plan.ts`
 * (`buildRenderPlan`), dibuktikan setara field per field oleh
 * `test/plan.test.ts`. Yang tersisa di sini hanya pembungkus yang
 * menerjemahkan bahasa fixture (`family`, `stochasticEffectsActive`) ke
 * `RenderParams`, supaya setiap gerbang parity yang memanggilnya ikut
 * membuktikan jalur produksi -- bukan salinan terpisah yang bisa hanyut.
 *
 * `stochasticEffectsActive` memetakan ke `grainEnabled` DAN `glareEnabled`
 * sekaligus: `deactivate_stochastic_effects` Python mematikan keduanya
 * bersamaan (`params_builder.py:140-142`), dan `validateRenderParams` menolak
 * kombinasi campuran yang tidak pernah dibangkitkan Python.
 */
export function defaultCoreParams(
  width: number,
  height: number,
  bundle: AssetBundle,
  inputRgba: Float32Array,
  family: CoreParamsFamily,
  stochasticEffectsActive: boolean,
  stockId: string = 'kodak_portra_400',
): CoreParams {
  const params: RenderParams = {
    ...BASELINE_RENDER_PARAMS,
    film: stockId,
    grainEnabled: stochasticEffectsActive,
    glareEnabled: stochasticEffectsActive,
  };
  const mode = family === 'lut' ? 'cube' : 'image';
  return buildRenderPlan(params, bundle, { width, height, rgba: inputRgba }, mode).core;
}
