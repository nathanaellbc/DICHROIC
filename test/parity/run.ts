import { acquireDevice } from '../../src/engine/device';
import { RenderGraph } from '../../src/engine/graph';
import { precomputeArenaData, uploadArenas } from '../../src/host/spectral';
import { loadAssets } from '../../src/profiles/load';
import type { AssetBundle } from '../../src/profiles/load';
import type { ArenaPlan } from '../../src/host/spectral';
import type { Arenas } from '../../src/engine/arena';
import type { EngineDevice } from '../../src/engine/device';
import type { Stage } from '../../src/engine/graph';
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

async function sharedResources(stockId: string) {
  sharedBundle ??= loadAssets('public/data');
  const bundle = await sharedBundle;

  // Pra-hitung SEBELUM device diakuisisi -- lih. blok komentar di atas.
  let plan = pendingPlans.get(stockId);
  if (!plan && !sharedArenas.has(stockId)) {
    plan = precomputeArenaData(bundle, stockId);
    pendingPlans.set(stockId, plan);
  }

  sharedEngine ??= acquireDevice();
  const engine = await sharedEngine;

  let arenas = sharedArenas.get(stockId);
  if (!arenas) {
    arenas = uploadArenas(engine.device, plan!);
    pendingPlans.delete(stockId);
    sharedArenas.set(stockId, arenas);
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
  const { engine, bundle, arenas } = await sharedResources(
    opts.stockId ?? 'kodak_portra_400',
  );

  assertFamilyMatchesCase(opts.case, opts.family);

  const graph = new RenderGraph(engine);
  for (const stage of opts.stages(engine.device, arenas)) graph.addStage(stage);

  const meta = loadCase(opts.case);
  const inputRgba = loadInputAsRgba(opts.inputCase ?? opts.case);
  // `defaultCoreParams` butuh `inputRgba` untuk meniru auto-exposure metering
  // Python (bergantung isi gambar) -- lih. test/parity/params.ts untuk bukti
  // kenapa ini bukan sekadar (width, height, bundle) seperti sketsa brief.
  // `family` menentukan apakah EV itu benar-benar dipakai (lih. params.ts).
  const params = defaultCoreParams(meta.width, meta.height, bundle, inputRgba, opts.family);

  const actual = await graph.run(inputRgba, params, opts.tap);

  expectWithinTolerance(
    compareRgb(actual, loadTap(opts.case, opts.tap)),
    opts.tolerance,
    `${opts.tap} / ${opts.case}`,
  );
}
