import { acquireDevice } from '../../src/engine/device';
import { RenderGraph } from '../../src/engine/graph';
import { precomputeArenaData, uploadArenas } from '../../src/host/spectral';
import { loadAssets } from '../../src/profiles/load';
import type { AssetBundle } from '../../src/profiles/load';
import type { ArenaPlan, PrintScanArenaOptions } from '../../src/host/spectral';
import type { Arenas } from '../../src/engine/arena';
import type { EngineDevice } from '../../src/engine/device';
import type { FrameParams, Stage } from '../../src/engine/graph';
import type { TapName } from '../../src/engine/taps';
import { compareRgb, expectWithinTolerance, loadCase, loadInputAsRgba, loadTap } from './compare';
import { defaultCoreParams } from './params';
import type { CoreParamsFamily } from './params';

/**
 * Dipindahkan ke sini dari Task 10 (lih. ledger K5): `run.ts` mengimpor
 * `buildArenas` dari `src/host/spectral.ts`, yang baru lahir di Task 11.
 */
export interface TapParityOptions {
  case: string;
  tap: TapName;
  tolerance: number;
  stages: (device: GPUDevice, arenas: Arenas) => Stage[];
  stockId?: string;
  /**
   * Keluarga fixture `case` mewakili -- WAJIB, tidak ada default (lih.
   * `params.ts::CoreParamsFamily`). Menentukan bagaimana `filmExposureEv`
   * dihitung di `defaultCoreParams`; kombinasi yang salah (mis. `family:
   * 'measured'` dipakai untuk direktori `_lut`) digagalkan di bawah,
   * bukan dibiarkan menghasilkan EV yang kelihatan masuk akal tapi salah.
   */
  family: CoreParamsFamily;
  /**
   * Task 18c -- WAJIB, tidak ada default (lih. dokumentasi parameter yang
   * sama persis di `params.ts::defaultCoreParams`, yang meneruskan nilai
   * ini apa adanya): apakah `debug.deactivate_stochastic_effects` MATI
   * (grain/glare Python hidup, keluarga fixture `<case>_stochastic`) atau
   * HIDUP (grain/glare Python mati, keluarga fixture dasar `<case>`).
   * `family: 'measured'` SENDIRIAN tidak cukup membedakan keduanya --
   * lih. `defaultCoreParams` untuk bug nyata yang ini perbaiki (Gate B
   * `rgb_out` keluarga `<case>` biasa memerahkan 1.8 max abs error karena
   * glare stokastik ikut jalan padahal Python mematikannya).
   */
  stochasticEffectsActive: boolean;
  /**
   * Direktori fixture yang menyimpan `input.f32`, jika BUKAN `case` itu
   * sendiri. `gen_reference.py` hanya menulis `input.f32` sekali, di
   * direktori kasus dasar -- `<case>_stochastic` dan `<case>_lut` berbagi
   * berkas yang sama dengan `<case>` (lih. `_generate_case`), jadi
   * pemanggil yang membaca tap dari `<case>_lut` harus menyatakan
   * `inputCase: '<case>'` di sini. Baku ke `case` bila tidak diberikan
   * (benar untuk keluarga dasar/`measured` yang namanya sudah direktori
   * dasar).
   */
  inputCase?: string;
  /**
   * Task 17 (PrintScan) -- diteruskan ke `sharedResources`/
   * `precomputeArenaData` supaya arena `dynamic` `stockId` (FILM) ini juga
   * membawa entri PRINT. Tidak diberikan untuk gerbang non-PrintScan.
   */
  printScan?: PrintScanArenaOptions;
  /**
   * Fase 2A.5: format film (ukuran piksel) untuk run ini. WAJIB sama dengan
   * `filmFormatMm` di case.json bila fixture mencatatnya (keluarga
   * `_px6um`/`_px31um`); tanpa itu default 35 mm, seperti Python.
   */
  frame?: FrameParams;
}

/**
 * Sumber daya per-proses, di-memo SENGAJA, dan diurutkan SENGAJA.
 *
 * Urutannya WAJIB: muat aset, pra-hitung arena (murni CPU), BARU akuisisi
 * device, baru unggah ke GPU. Ini bukan selera. Kerja float CPU yang panjang
 * setelah `GPUDevice` hidup men-segfault proses Node pada titik sinkronisasi
 * queue berikutnya, 100% deterministik: loop pra-hitung 192x192x81 yang sama
 * crash 3/3 kalau device sudah hidup dan lolos 3/3 kalau belum. Rinciannya,
 * termasuk lima tersangka yang tersingkir satu per satu (jumlah operasi,
 * tekanan alokasi, buffer arena, shader, isi arena), ada di CATATAN LINGKUNGAN
 * di `src/host/spectral.ts`.
 *
 * Karena itu pula `sharedArenas` di-kunci per stock: pra-hitung stock KEDUA
 * akan berjalan setelah device hidup dan akan men-segfault. Task 12-19 yang
 * butuh lebih dari satu stock harus mem-pra-hitung semuanya SEBELUM
 * `acquireDevice()`, bukan menambah entri ke map ini di tengah jalan.
 *
 * Device dan aset juga di-memo karena `acquireDevice()` memanggil `create()`
 * milik binding `webgpu` (Dawn), yang memasang state global di dalam proses;
 * memanggilnya sekali per test menumpuk instance GPU tanpa alasan.
 *
 * Konsekuensi yang diterima: satu device dipakai bersama semua test parity,
 * jadi device yang hilang di satu test akan meracuni sisanya. Itu jauh lebih
 * baik daripada gerbang yang tidak pernah bisa dijalankan -- dan device yang
 * hilang adalah kegagalan yang memang harus dilihat, bukan disembunyikan.
 */
let sharedEngine: Promise<EngineDevice> | undefined;
let sharedBundle: Promise<AssetBundle> | undefined;
const sharedArenas = new Map<string, Arenas>();
const pendingPlans = new Map<string, ArenaPlan>();

/**
 * Kunci cache `sharedArenas`/`pendingPlans` -- SENGAJA menyertakan
 * `printScan.printStockId` (bukan hanya `stockId`) supaya Task 17
 * (`printScan.test.ts`, DUA stock: FILM `stockId` + PRINT `printStockId`)
 * TIDAK berbagi entri cache dengan test lain yang memakai `stockId` FILM
 * yang SAMA tanpa augmentasi print (`filmExposure.test.ts`/`grain.test.ts`/
 * dst.). Kalau kuncinya cuma `stockId`, siapa pun yang memanggil
 * `sharedResources('kodak_portra_400')` LEBIH DULU (urutan file test tidak
 * dijamin) akan mengunci arena `dynamic` TANPA field print untuk seluruh
 * proses vitest -- `printScan.test.ts` yang berjalan setelahnya diam-diam
 * memakai arena basi lewat cache-hit, bukan galat yang jelas.
 */
function arenaCacheKey(stockId: string, printScan?: PrintScanArenaOptions): string {
  return printScan ? `${stockId}::print=${printScan.printStockId}` : stockId;
}

/**
 * Diekspor (Task 16) supaya `grain.test.ts` bisa memakai ulang device/bundle/
 * arena yang sama (dan urutan pra-hitung-sebelum-akuisisi-device yang sama)
 * tanpa menduplikasi CATATAN LINGKUNGAN di `host/spectral.ts` -- gerbang
 * grain STATISTIK (`test/parity/statistics.ts`), bukan per-piksel, jadi
 * tidak bisa memakai `runTapParity` apa adanya, tapi tetap butuh sumber daya
 * device/arena yang SAMA persis.
 *
 * `printScan` (Task 17, opsional) -- diteruskan APA ADANYA ke
 * `precomputeArenaData` supaya arena `dynamic` yang diunggah untuk `stockId`
 * ini juga membawa entri PRINT (`addPrintScanDynamicData`). Lih.
 * `arenaCacheKey` di atas untuk kenapa ini butuh kunci cache sendiri.
 */
export async function sharedResources(stockId: string, printScan?: PrintScanArenaOptions) {
  sharedBundle ??= loadAssets('public/data');
  const bundle = await sharedBundle;

  const cacheKey = arenaCacheKey(stockId, printScan);

  // Pra-hitung SEBELUM device diakuisisi -- lih. blok komentar di atas.
  let plan = pendingPlans.get(cacheKey);
  if (!plan && !sharedArenas.has(cacheKey)) {
    plan = precomputeArenaData(bundle, stockId, printScan);
    pendingPlans.set(cacheKey, plan);
  }

  sharedEngine ??= acquireDevice();
  const engine = await sharedEngine;

  let arenas = sharedArenas.get(cacheKey);
  if (!arenas) {
    arenas = uploadArenas(engine.device, plan!);
    pendingPlans.delete(cacheKey);
    sharedArenas.set(cacheKey, arenas);
  }
  return { engine, bundle, arenas };
}

/**
 * Penjaga kombinasi (case, family) -- lih. komentar `family` di
 * `TapParityOptions` dan `CoreParamsFamily` di `params.ts`. Direktori
 * `_lut` dibangkitkan dengan `debug.lut_mode = True`, yang mematikan
 * `camera.auto_exposure` sepenuhnya di sisi Python (params_builder.py:
 * 105-107); direktori lain (`<case>`/`<case>_stochastic`) TIDAK
 * mematikannya. Menyilangkan keduanya tidak menghasilkan crash -- ia
 * menghasilkan `filmExposureEv` yang salah tapi "kelihatan masuk akal"
 * (nomor real, dalam rentang EV wajar), persis kegagalan senyap yang
 * brief minta dicegah. Digagalkan di sini, di satu tempat, bukan
 * diharapkan setiap pemanggil `runTapParity` mengingatnya sendiri.
 */
function assertFamilyMatchesCase(caseName: string, family: CoreParamsFamily): void {
  const isLutFixture = caseName.endsWith('_lut');
  if (family === 'lut' && !isLutFixture) {
    throw new Error(
      `runTapParity: family 'lut' diminta untuk case "${caseName}", yang tidak ` +
        'berakhiran "_lut". Fixture keluarga lut_mode HARUS memakai direktori ' +
        '<case>_lut (lih. tools/gen_reference.py) -- kombinasi ini kemungkinan salah ketik.',
    );
  }
  if (family === 'measured' && isLutFixture) {
    throw new Error(
      `runTapParity: family 'measured' diminta untuk case "${caseName}", yang ` +
        'BERAKHIRAN "_lut". Fixture ini dibangkitkan dengan debug.lut_mode=True ' +
        '(camera.auto_exposure dipaksa mati) -- measureAutoExposureEv akan ' +
        'menghitung EV dari isi gambar dan menghasilkan angka yang kelihatan ' +
        'masuk akal tapi SALAH. Pakai family: \'lut\'.',
    );
  }
}

export async function runTapParity(opts: TapParityOptions): Promise<void> {
  const stockId = opts.stockId ?? 'kodak_portra_400';
  const { engine, bundle, arenas } = await sharedResources(stockId, opts.printScan);

  assertFamilyMatchesCase(opts.case, opts.family);

  const graph = new RenderGraph(engine);
  for (const stage of opts.stages(engine.device, arenas)) graph.addStage(stage);

  const meta = loadCase(opts.case);
  const inputRgba = loadInputAsRgba(opts.inputCase ?? opts.case);
  // `defaultCoreParams` butuh `inputRgba` untuk meniru auto-exposure metering
  // Python (bergantung isi gambar) -- lih. test/parity/params.ts untuk bukti
  // kenapa ini bukan sekadar (width, height, bundle) seperti sketsa brief.
  // `family` menentukan apakah EV itu benar-benar dipakai (lih. params.ts).
  // `stockId` (Task 12+) menentukan `exposureCount` -- HARUS stock yang sama
  // dengan yang arena-nya dibangun di `sharedResources` di atas, atau
  // `curveDevelop.wgsl` akan mencari batas kurva stock yang salah.
  const params = defaultCoreParams(
    meta.width,
    meta.height,
    bundle,
    inputRgba,
    opts.family,
    opts.stochasticEffectsActive,
    stockId,
  );

  const caseFormat = (meta as { filmFormatMm?: number }).filmFormatMm;
  if (caseFormat !== undefined && opts.frame?.filmFormatMm !== caseFormat) {
    throw new Error(
      `runTapParity: case "${opts.case}" dibangkitkan dengan film_format_mm=${caseFormat}, ` +
        `tapi frame.filmFormatMm=${String(opts.frame?.filmFormatMm)}.`,
    );
  }
  const actual = await graph.run(inputRgba, params, opts.tap, opts.frame ? { frame: opts.frame } : undefined);

  expectWithinTolerance(
    compareRgb(actual, loadTap(opts.case, opts.tap)),
    opts.tolerance,
    `${opts.tap} / ${opts.case}`,
  );
}
