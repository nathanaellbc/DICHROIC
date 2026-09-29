/**
 * Graf render: rangkaian `Stage` yang dijalankan berurutan di atas SATU
 * pasangan buffer ping-pong, berhenti pada tahap terakhir yang menulis tap
 * yang diminta pemanggil.
 *
 * Ini mencerminkan topologi referensi Python: sebuah "tap" bukan lokasi
 * penyimpanan tersendiri, melainkan label checkpoint pada satu buffer citra
 * yang terus disempurnakan tahap demi tahap. `CurveDevelop`, `Dir`,
 * `Halation`, `Grain`, dan `Diffusion['camera']` (Task 13-16) semuanya
 * MENULIS `cmy_film` — masing-masing menyempurnakan keadaan yang sama, bukan
 * menghasilkan salinan baru. Karena itu `run()` mencari tahap **terakhir**
 * yang menulis tap yang diminta (bukan yang pertama): memakai kecocokan
 * pertama akan menghentikan graf di tahap pertama yang menyentuh tap itu dan
 * membuat tahap-tahap penyempurna berikutnya lulus tanpa pernah berjalan.
 *
 * `Array.prototype.findLastIndex` (ES2023) SENGAJA tidak dipakai — lib
 * tsconfig paket ini adalah `ES2022`, yang mendahului method itu; memakainya
 * akan lulus di runtime Node tapi gagal `tsc -b --noEmit`. `findLastStageIndex`
 * di bawah adalah loop terbalik manual yang setara, tanpa menaikkan target lib.
 */

import { CORE_PARAMS_BYTES, writeCoreParams } from './params';
import type { CoreParams } from './params';
import type { EngineDevice } from './device';
import type { TapName } from './taps';
import { gpuBufferUsage, gpuMapMode } from './webgpuGlobals';
import { planTiles } from './tiling';
import type { TileSpec } from './tiling';

/**
 * Nilai per-render yang dipakai HOST saat meng-encode tahap, tapi tidak
 * masuk blok `CoreParams` (yang sengaja mencerminkan persis push-constant OFX,
 * 26 field -- `test/params.test.ts`). Fase 2A.5: `filmFormatMm` menggantikan
 * konstanta 35.0 yang dulu disalin di halation/DIR/grain, supaya ukuran
 * piksel (`film_format_mm * 1000 / max(fullWidth, fullHeight)`, Python
 * `ResizingService.pixel_size_um`) bisa disetel -- termasuk ke ukuran piksel
 * foto sungguhan pada fixture 64 px.
 */
export interface FrameParams {
  filmFormatMm: number;
  /**
   * Fase 2C: `camera.exposure_compensation_ev` Python (EV kompensasi, TANPA
   * auto-exposure) untuk midgray `_comp` print. Baku 0.
   */
  exposureCompensationEv?: number;
  /** Fase 2C: `enlarger.print_exposure_compensation` Python. Baku `false`. */
  printExposureCompensation?: boolean;
  /** Fase 2C: `enlarger.print_exposure` Python (linear, `2**printExposureEv`). Baku 1. */
  printExposure?: number;
  /** Fase 2C: `film_render.halation.active` Python. Baku `true`. */
  halationEnabled?: boolean;
  /** Fase 2C: `film_render.halation.halation_amount` Python. Baku 1. */
  halationAmount?: number;
  /** Fase 2C: `scanner.unsharp_mask[1]` Python (amount; sigma tetap 0.7 px). Baku 0.7. */
  scannerUnsharpAmount?: number;
  /** Fase 2C: `print_render.glare.percent` Python. Baku 0.03. */
  glarePercent?: number;
  /** Fase 2C: `grainSeed` OFX (RNG grain; Python memakai seed tetap). Baku 1. */
  grainSeed?: number;
  /** Fase 2C: `grainAmount` OFX (`applyGrainControls`). Baku 1. */
  grainAmount?: number;
  /**
   * Fase 2C: pengali nilai input TER-ENCODE sebelum decode CCTF
   * (`2**autoexposure_ev`, Python `FilmingStage.auto_exposure`). Hanya dibaca
   * bila flag decode menyala. Baku 1.
   */
  inputDecodeScale?: number;
  /**
   * Fase 2D: `film_render.dir_couplers` Python -- `amount` (0 bila
   * `active=False`), `inhibition_samelayer`, `inhibition_interlayer`, dan
   * `diffusion_size_um` (0 mematikan difusi spasial, termasuk ekornya).
   * Baku 1, 1, 1, 20.
   */
  dirCouplersAmount?: number;
  dirInhibitionSameLayer?: number;
  dirInhibitionInterlayer?: number;
  dirDiffusionUm?: number;
  /**
   * Fase 2D: `enlarger.preflash_exposure` dan shift filter M/Y preflash
   * Python. Baku 0 (preflash mati).
   */
  preflashExposure?: number;
  preflashMFilterShift?: number;
  preflashYFilterShift?: number;
}

/** Python `CameraParams.film_format_mm` default (35 mm). */
export const DEFAULT_FRAME: Readonly<FrameParams> = Object.freeze({ filmFormatMm: 35 });

export interface StageContext {
  device: GPUDevice;
  params: CoreParams;
  frame: Readonly<FrameParams>;
  paramsBuffer: GPUBuffer;
  source: GPUBuffer;
  dest: GPUBuffer;
  /**
   * Buffer antara milik graf, dipakai ulang antar dispatch berlabel sama.
   * Tahap multi-pass (Task 11+) HARUS memperoleh buffer perantaranya lewat
   * fungsi ini, bukan `device.createBuffer()` sendiri — pool-nya berumur
   * selama instance `RenderGraph`, bukan selama satu `run()`, persis supaya
   * render ter-tile (Task 19, satu `run()` per tile pada graf yang sama)
   * tidak menciptakan buffer baru per tile per tahap dan meledakkan VRAM.
   */
  scratch(label: string, bytes: number): GPUBuffer;
}

export interface Stage {
  name: string;
  /** Setiap tap kanonis yang ditulis tahap ini. Kosong untuk tahap murni internal. */
  writesTaps: readonly TapName[];
  /**
   * Task 19b: radius (px) apron spasial yang tahap ini "konsumsi" setelah
   * berjalan -- port `xRadius`/`consumeSpatialRadius(xRadius)` hulu
   * (`SpektraVulkanRenderer.cpp:4999-5006`/`:6238-6244`, konstanta sama
   * `SPATIAL_EFFECT_RADIUS_PX`/`GRAIN_SPATIAL_RADIUS_PX` yang
   * `tiling.ts::estimateTileOverlap` jumlahkan untuk merencanakan apron
   * buffer). Dipakai HANYA oleh `RenderGraph.runSingleBuffer` saat
   * `shrinkApron` benar (render ter-tile sungguhan, lih. `runTiled` di
   * bawah) -- untuk render full-frame biasa field ini tidak pernah dibaca,
   * `params.activeWidth/Height` pemanggil dipakai apa adanya untuk SETIAP
   * tahap sama seperti sebelum Task 19b. `undefined`/`0` (baku) untuk
   * tahap tanpa kernel spasial (materializeActiveRegion, filmExposure,
   * curveDevelop, printExpose/printDevelop).
   */
  spatialRadiusPx?: number | ((params: CoreParams, frame: Readonly<FrameParams>) => number);
  encode(encoder: GPUCommandEncoder, ctx: StageContext): void;
}

/**
 * Fase 2A.5: radius boleh bergantung ukuran piksel (sigma halation/DIR dalam
 * um -> px, `src/engine/spatialRadius.ts`), jadi diselesaikan per run dari
 * `params` (dimensi gambar penuh) dan `frame` (format film).
 */
function resolveSpatialRadius(stage: Stage, params: CoreParams, frame: Readonly<FrameParams>): number {
  const r = stage.spatialRadiusPx;
  if (r === undefined) return 0;
  return typeof r === 'function' ? r(params, frame) : r;
}

const PING_PONG_USAGE =
  gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_SRC | gpuBufferUsage.COPY_DST;

/**
 * Loop terbalik manual yang setara `Array.prototype.findLastIndex` — lih.
 * komentar modul di atas untuk alasan tidak memakai method bawaan itu.
 */
function findLastStageIndex(stages: readonly Stage[], tap: TapName): number {
  for (let i = stages.length - 1; i >= 0; i -= 1) {
    if (stages[i]!.writesTaps.includes(tap)) return i;
  }
  return -1;
}

/** Sub-rektangel `{x, y, width, height}` sederhana -- dipakai `inflateActiveRect` di bawah. */
interface ActiveRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Task 19b: port `inflatedCenterRect` + `setActiveRect` hulu
 * (`SpektraVulkanRenderer.cpp:6195-6217`) -- membesarkan `center` (rektangel
 * AKTIF tile, TANPA apron) sebesar `radius` di setiap sisi, diklip ke
 * `[0,bufWidth) x [0,bufHeight)`. Ini persis mekanisme yang MENULISKAN apron:
 * dipanggil sebelum setiap tahap dengan `radius = remainingSpatialRadius`
 * ("radius efek spasial yang BELUM dikonsumsi tahap manapun sejauh ini",
 * lih. `runSingleBuffer`), jadi tahap paling awal memproses AKTIF+SELURUH
 * apron yang tersisa, dan tiap tahap spasial mengonsumsi radiusnya sendiri
 * sampai tahap TERAKHIR memproses persis `center` -- rektangel keluaran tile
 * yang sebenarnya, TANPA apron.
 *
 * Fallback "seluruh buffer" saat hasil kempis ke lebar/tinggi nol mengikuti
 * `setActiveRect` hulu persis (baris 6213-6216) -- tidak akan terpicu untuk
 * `radius>=0` dan `center` yang valid (lebar/tinggi aktif tile SELALU >0,
 * dijamin `planTiles`), tapi diport apa adanya demi kesetiaan, bukan
 * dihilangkan sebagai "tidak mungkin terjadi".
 */
function inflateActiveRect(
  center: ActiveRect,
  radius: number,
  bufWidth: number,
  bufHeight: number,
): ActiveRect {
  const x0 = center.x > radius ? center.x - radius : 0;
  const y0 = center.y > radius ? center.y - radius : 0;
  const x1 = Math.min(bufWidth, center.x + center.width + radius);
  const y1 = Math.min(bufHeight, center.y + center.height + radius);

  const originX = Math.min(x0, bufWidth);
  const originY = Math.min(y0, bufHeight);
  const width = Math.min(x1 > x0 ? x1 - x0 : 0, bufWidth - originX);
  const height = Math.min(y1 > y0 ? y1 - y0 : 0, bufHeight - originY);

  if (width === 0 || height === 0) {
    return { x: 0, y: 0, width: bufWidth, height: bufHeight };
  }
  return { x: originX, y: originY, width, height };
}

/**
 * Task 19: ekstrak buffer satu tile (`tile.tileWidth x tile.tileHeight`,
 * termasuk apron) dari `source` bertata-letak gambar PENUH
 * (`fullWidth x fullHeight`, tersirat dari `fullWidth` di sini karena
 * `planTiles` menjamin `tile.tileOriginX/Y + tile.tileWidth/Height <=
 * fullWidth/Height` -- lih. `tiling.ts`). Baris-demi-baris (bukan satu
 * `subarray`) dengan alasan yang SAMA seperti
 * `materializeActiveRegion.wgsl`: sub-rektangel dari tata-letak 2D bukan
 * rentang byte kontigu.
 */
function extractTileInput(source: Float32Array, fullWidth: number, tile: TileSpec): Float32Array {
  const out = new Float32Array(tile.tileWidth * tile.tileHeight * 4);
  for (let row = 0; row < tile.tileHeight; row += 1) {
    const srcRowStart = ((tile.tileOriginY + row) * fullWidth + tile.tileOriginX) * 4;
    const dstRowStart = row * tile.tileWidth * 4;
    out.set(source.subarray(srcRowStart, srcRowStart + tile.tileWidth * 4), dstRowStart);
  }
  return out;
}

/**
 * Task 19: jahit HANYA sub-rektangel AKTIF (`tile.activeWidth x
 * tile.activeHeight`, TANPA apron) dari hasil satu tile ke posisi
 * globalnya pada `output` bertata-letak gambar PENUH. Posisi lokal
 * sub-rektangel aktif di dalam buffer hasil tile adalah
 * `tile.activeOriginX/Y - tile.tileOriginX/Y` -- SAMA persis konversi
 * yang `runTiled` pakai untuk mengisi `CoreParams.activeOriginX/Y` saat
 * mendispatch tile ini (lih. `runTiled`), jadi baris yang dijahit di sini
 * SELALU baris yang benar-benar ditulis tahap terakhir graf untuk tile
 * ini.
 */
function stitchTileOutput(
  output: Float32Array,
  fullWidth: number,
  tileResult: Float32Array,
  tile: TileSpec,
): void {
  const localOriginX = tile.activeOriginX - tile.tileOriginX;
  const localOriginY = tile.activeOriginY - tile.tileOriginY;
  for (let row = 0; row < tile.activeHeight; row += 1) {
    const srcRowStart = ((localOriginY + row) * tile.tileWidth + localOriginX) * 4;
    const dstRowStart = ((tile.activeOriginY + row) * fullWidth + tile.activeOriginX) * 4;
    output.set(tileResult.subarray(srcRowStart, srcRowStart + tile.activeWidth * 4), dstRowStart);
  }
}

export class RenderGraph {
  private readonly stages: Stage[] = [];
  /**
   * Pool buffer scratch, dikunci per label. SENGAJA TIDAK dibersihkan di
   * akhir `run()` — lih. dokumentasi `StageContext.scratch` di atas. Umurnya
   * adalah umur `RenderGraph` ini, dibersihkan lewat `dispose()` eksplisit.
   */
  private readonly pool = new Map<string, GPUBuffer>();
  #disposed = false;

  constructor(private readonly engine: EngineDevice) {}

  addStage(stage: Stage): void {
    this.stages.push(stage);
  }

  private scratch(label: string, bytes: number): GPUBuffer {
    const existing = this.pool.get(label);
    if (existing && existing.size >= bytes) return existing;
    existing?.destroy();

    const buffer = this.engine.device.createBuffer({
      label: `scratch:${label}`,
      size: bytes,
      usage: PING_PONG_USAGE,
    });
    this.pool.set(label, buffer);
    return buffer;
  }

  /**
   * Task 19: titik masuk publik. `options.maxBufferBytes`, bila diberikan,
   * diteruskan ke `planTiles` (lih. `tiling.ts`) untuk merencanakan grid
   * tile; "tiling jika perlu" (rencana Task 19) diputuskan dari HASIL
   * perencanaan itu sendiri (`tiles.length > 1`), bukan dari perbandingan
   * ukuran terpisah -- untuk gambar kecil dengan apron produksi (256px
   * OFX vs gambar 32-64px), `params.width*height` sudah lebih kecil dari
   * budget apa pun yang masuk akal SEKALIGUS apron sendirian sudah
   * melebihi gambar; satu perbandingan ukuran tunggal tidak bisa
   * menangkap kedua kasus itu sekaligus, sementara "berapa tile yang
   * `planTiles` hasilkan" selalu benar oleh konstruksi.
   *
   * `options.overlap` — BUKAN bagian tanda tangan yang dituliskan rencana
   * (`{ maxBufferBytes?: number }` saja) tapi tanpanya pemanggil tidak
   * punya cara memberi tahu `RenderGraph` seberapa besar apron dibutuhkan
   * — `RenderGraph` sendiri buta terhadap tahap spasial mana yang aktif
   * (`Stage` adalah tipe opak, lih. dokumentasi modul di atas);
   * `estimateTileOverlap` (`tiling.ts`) ada justru untuk pemanggil hitung
   * nilai ini dari `SpatialEffectFlags` sebelum memanggil `run()`. Baku ke
   * 0 (tanpa apron) bila tidak diberikan — SALAH untuk render dengan efek
   * spasial aktif, jadi pemanggil yang memaksa tiling WAJIB
   * menyertakannya.
   */
  async run(
    input: Float32Array,
    params: CoreParams,
    collect: TapName,
    options?: { maxBufferBytes?: number; overlap?: number; frame?: FrameParams },
  ): Promise<Float32Array> {
    const frame = options?.frame ?? DEFAULT_FRAME;
    const maxBufferBytes = options?.maxBufferBytes;
    if (maxBufferBytes !== undefined) {
      const overlap = options?.overlap ?? 0;
      const tiles = planTiles(params.width, params.height, maxBufferBytes, overlap);
      if (tiles.length > 1) {
        return this.runTiled(input, params, collect, tiles, frame);
      }
    }
    return this.runSingleBuffer(input, params, collect, false, frame);
  }

  /**
   * Task 19: render satu tile per panggilan `runSingleBuffer` (graf/pool
   * yang SAMA, lih. dokumentasi `StageContext.scratch` di atas), menjahit
   * hanya sub-rektangel AKTIF tiap tile (bukan buffernya yang termasuk
   * apron) ke posisi globalnya pada `output`. `planTiles` menjamin
   * sub-rektangel aktif itu menutupi `params.width x params.height` PENUH
   * tanpa celah/tumpang-tindih (`tiling.test.ts`) — perulangan di bawah
   * karena itu boleh menimpa `output` tanpa penjaga tambahan.
   */
  private async runTiled(
    input: Float32Array,
    params: CoreParams,
    collect: TapName,
    tiles: readonly TileSpec[],
    frame: Readonly<FrameParams>,
  ): Promise<Float32Array> {
    const { width, height } = params;
    const output = new Float32Array(width * height * 4);

    for (const tile of tiles) {
      const tileInput = extractTileInput(input, width, tile);
      const tileParams: CoreParams = {
        ...params,
        width: tile.tileWidth,
        height: tile.tileHeight,
        tileOriginX: tile.tileOriginX,
        tileOriginY: tile.tileOriginY,
        // TileSpec.activeOriginX/Y ada di ruang koordinat gambar PENUH
        // (lih. dokumentasi `TileSpec`) -- CoreParams.activeOriginX/Y
        // LOKAL ke buffer tile, jadi tileOriginX/Y dikurangkan di sini.
        activeOriginX: tile.activeOriginX - tile.tileOriginX,
        activeOriginY: tile.activeOriginY - tile.tileOriginY,
        activeWidth: tile.activeWidth,
        activeHeight: tile.activeHeight,
      };
      // Task 19b: `shrinkApron=true` -- SATU-satunya pemanggil yang minta
      // `RenderGraph` menyusutkan active rect per-tahap (lih. dokumentasi
      // parameter itu di `runSingleBuffer`). `tileParams.activeOriginX/Y/
      // activeWidth/Height` di atas SUDAH benar sebagai rektangel AKTIF
      // (pusat, TANPA apron) tile ini -- `runSingleBuffer` memakainya
      // sebagai `centerRect` awal yang dibesarkan per-tahap, BUKAN sebagai
      // active rect tetap untuk seluruh tahap (beda dari sebelum Task 19b).
      const tileResult = await this.runSingleBuffer(tileInput, tileParams, collect, true, frame);
      stitchTileOutput(output, width, tileResult, tile);
    }

    return output;
  }

  /**
   * @param shrinkApron Task 19b -- bila benar, `params.activeOriginX/Y/
   *   activeWidth/Height` diperlakukan sebagai `centerRect` (rektangel
   *   AKTIF tile, TANPA apron) yang dibesarkan ULANG sebelum SETIAP tahap
   *   sebesar `remainingSpatialRadius` ("jumlah `Stage.spatialRadiusPx`
   *   tahap ini dan semua tahap SETELAHnya yang akan berjalan" -- port
   *   `setActiveForRemainingRadius`/`consumeSpatialRadius` hulu,
   *   `SpektraVulkanRenderer.cpp:6231-6245` + tujuh call-site
   *   `consumeSpatialRadius` di :6444-6604), bukan dipakai APA ADANYA untuk
   *   seluruh graf seperti sebelumnya. Baku `false` (perilaku pra-Task
   *   19b, dipakai ke-349 gerbang lain yang TIDAK PERNAH lewat
   *   `runTiled` di bawah): setiap tahap memakai `paramsBuffer`/`params`
   *   yang SAMA, ditulis SEKALI di luar loop, persis kode sebelum Task 19b.
   */
  private async runSingleBuffer(
    input: Float32Array,
    params: CoreParams,
    collect: TapName,
    shrinkApron = false,
    frame: Readonly<FrameParams> = DEFAULT_FRAME,
  ): Promise<Float32Array> {
    if (this.#disposed) {
      throw new Error(
        'RenderGraph ini sudah di-dispose() -- pool scratch-nya sudah dihancurkan. ' +
          'Memanggil run() lagi akan diam-diam membangun ulang pool dari kosong ' +
          '(kehilangan seluruh reuse antar-tile yang pool itu ada untuk menjaga) ' +
          'sambil tetap menghasilkan piksel yang benar, sehingga tidak akan ' +
          'terlihat sebagai bug sama sekali. Buat RenderGraph baru alih-alih ' +
          'memakai ulang instance yang sudah di-dispose().',
      );
    }

    const expectedFloats = params.width * params.height * 4;
    const expectedBytes = expectedFloats * Float32Array.BYTES_PER_ELEMENT;
    if (input.byteLength !== expectedBytes) {
      throw new Error(
        `Ukuran input tidak cocok dengan params: params.width (${params.width}) x ` +
          `params.height (${params.height}) x 4 komponen x 4 byte = ${expectedBytes} byte ` +
          `diharapkan, tapi input.byteLength adalah ${input.byteLength} byte. Tanpa ` +
          'pemeriksaan ini, ketidakcocokan muncul sebagai peringatan validasi WebGPU ' +
          'asinkron yang terlepas dari panggilan run() yang menyebabkannya.',
      );
    }

    const stopAt = findLastStageIndex(this.stages, collect);
    if (stopAt === -1) {
      const registered =
        this.stages.length === 0
          ? '(tidak ada tahap terdaftar pada graf ini)'
          : this.stages.map((s) => `${s.name}→[${s.writesTaps.join('|')}]`).join(', ');
      throw new Error(
        `Tidak ada tahap yang menulis tap '${collect}'. Tahap terdaftar: ${registered}`,
      );
    }

    const { device } = this.engine;
    const bytes = input.byteLength;

    // Review seluruh-branch, agenda #1 (`docs/superpowers/plans/2026-09-11-
    // dichroic-phase1-engine.md`): `front`/`back` dialokasikan ulang di
    // SINI, sekali per panggilan `runSingleBuffer` -- sejak Task 19 itu
    // berarti SEKALI PER TILE (`runTiled` memanggil ini satu kali per
    // `TileSpec`), bukan sekali per frame seperti sebelum tiling ada. Task 9
    // menunda "apakah ini perlu dikolam seperti `StageContext.scratch()`" ke
    // titik ini, dengan alasan "Dawn di sini rapuh terhadap pola alokasi".
    //
    // DIUKUR di sini sebelum diputuskan (sesi ini), bukan diasumsikan:
    //   - Biaya create+destroy TERISOLASI sepasang buffer seukuran ini
    //     (64x64x4x4 byte): ~0,059 ms/pasang (256 pasang, 15,15 ms total).
    //   - Render 4-tile (hard_edge, fullChain, geometri "Task 19" gerbang
    //     bit-identik di atas): rata-rata 37-40 ms per render (5 run),
    //     8 alokasi ping-pong/run (2/tile) dari 216 alokasi buffer TOTAL
    //     per run (~3,7%) -- kontribusi ping-pong terisolasi ke waktu
    //     dinding: ~0,24 ms dari ~38 ms (~0,6%).
    //   - Render 64-tile (8x8, geometri yang SAMA diperkecil overlap-nya):
    //     440 ms total, 128 alokasi ping-pong (2/tile) -- kontribusi
    //     terisolasi ~3,8 ms dari 440 ms (~0,9%). Keluaran tetap finite,
    //     TIDAK ADA crash pada 64 tile (16x tile count gerbang bit-identik
    //     di atas).
    //   - Kerapuhan Dawn yang didokumentasikan di proyek ini
    //     (`src/host/spectral.ts`, CATATAN LINGKUNGAN) SUDAH menyingkirkan
    //     "tekanan alokasi" secara eksplisit sebagai tersangka pada segfault
    //     yang ditemukan Task 11 -- itu kerja float CPU SETELAH device hidup,
    //     TERBUKTI bukan soal create/destroy buffer sama sekali (400 MB
    //     Float32Array dialokasikan+dibuang dengan device hidup, lolos).
    //
    // KEPUTUSAN: TIDAK dikolam. Kontribusi terukur create/destroy ke waktu
    // dinding total berada di bawah 1% pada kedua skala yang diuji, dan
    // tidak ada indikasi ketidakstabilan pada 64 tile. Mengolam `front`/
    // `back` (menambah state lifecycle -- ukuran per-tile BERBEDA per tile
    // pada tiling non-seragam, jadi kolam butuh logika resize/reuse yang
    // `StageContext.scratch()` sudah punya untuk KASUS LAIN) akan menambah
    // kerumitan tanpa manfaat terukur -- persis "jangan ubah kode tanpa
    // alasan terukur" yang aturan proyek ini minta. Ukur ulang di sini kalau
    // profil produksi sungguhan (bukan fixture test) suatu hari menunjukkan
    // gambaran berbeda.
    let front = device.createBuffer({ label: 'ping', size: bytes, usage: PING_PONG_USAGE });
    let back = device.createBuffer({ label: 'pong', size: bytes, usage: PING_PONG_USAGE });
    // `input.buffer` bertipe `ArrayBufferLike` (bisa `SharedArrayBuffer`) di
    // definisi lib TS terbaru, sementara `writeBuffer` mensyaratkan
    // `ArrayBuffer` non-shared. `input` di sini SELALU `Float32Array` biasa
    // yang pemanggil bangun sendiri (lih. graph.test.ts) — tidak pernah
    // shared — jadi cast ini menyempitkan tipe, bukan mengubah perilaku.
    device.queue.writeBuffer(
      front,
      0,
      input.buffer as ArrayBuffer,
      input.byteOffset,
      input.byteLength,
    );

    const paramsBuffer = device.createBuffer({
      label: 'coreParams',
      size: CORE_PARAMS_BYTES,
      usage: gpuBufferUsage.UNIFORM | gpuBufferUsage.COPY_DST,
    });
    const staging = new ArrayBuffer(CORE_PARAMS_BYTES);
    writeCoreParams(params, staging);
    device.queue.writeBuffer(paramsBuffer, 0, staging);

    // Task 19b: `remainingSpatialRadius` -- SATU-SATUNYA state baru loop ini
    // butuh. Dimulai dari jumlah `spatialRadiusPx` SEMUA tahap yang akan
    // benar-benar berjalan (0..stopAt, BUKAN seluruh `this.stages` -- tahap
    // setelah titik `collect` tidak pernah dieksekusi, jadi radiusnya tidak
    // pernah "dikonsumsi" apa pun dan tidak boleh ikut dijumlahkan, persis
    // upstream yang HANYA menjumlahkan `xRadius` efek yang `xPath` true).
    // Tetap 0 (dan karena itu `inflateActiveRect` di bawah selalu no-op,
    // mengembalikan `centerRect` yang SAMA setiap tahap) ketika
    // `!shrinkApron` -- lih. dokumentasi parameter itu.
    let remainingSpatialRadius = 0;
    if (shrinkApron) {
      for (let i = 0; i <= stopAt; i += 1) {
        remainingSpatialRadius += resolveSpatialRadius(this.stages[i]!, params, frame);
      }
    }
    const centerRect: ActiveRect = {
      x: params.activeOriginX,
      y: params.activeOriginY,
      width: params.activeWidth,
      height: params.activeHeight,
    };

    // Task 19b: uniform buffer CoreParams KECIL per tahap, dipakai HANYA
    // saat `shrinkApron` (satu per tahap 0..stopAt, active rect BERBEDA
    // tiap tahap) -- lih. dokumentasi `Stage.spatialRadiusPx` untuk kenapa
    // ini HARUS buffer terpisah (bukan menulis ulang `paramsBuffer` yang
    // sama berkali-kali): `queue.writeBuffer` berkali-kali ke SATU buffer
    // sebelum SATU `submit()` di akhir fungsi ini akan membuat hanya
    // penulisan TERAKHIR yang terlihat GPU untuk SELURUH command buffer
    // (semua penulisan itu terjadi sebelum submit manapun dieksekusi) --
    // menulis ke buffer BARU per tahap sepenuhnya aman terlepas urutan itu,
    // karena tiap buffer hanya ditulis SEKALI, sebelum `submit()` mana pun.
    // Dikumpulkan di sini untuk di-`destroy()` setelah `submit()`, bukan
    // sebelumnya (destroy sebelum GPU selesai memakainya adalah use-after-
    // destroy).
    const perStageParamsBuffers: GPUBuffer[] = [];

    const encoder = device.createCommandEncoder({ label: 'graph' });
    for (let i = 0; i <= stopAt; i += 1) {
      const stage = this.stages[i]!;
      let stageParams = params;
      let stageParamsBuffer = paramsBuffer;

      if (shrinkApron) {
        const rect = inflateActiveRect(centerRect, remainingSpatialRadius, params.width, params.height);
        stageParams = {
          ...params,
          activeOriginX: rect.x,
          activeOriginY: rect.y,
          activeWidth: rect.width,
          activeHeight: rect.height,
        };

        const stageParamsStaging = new ArrayBuffer(CORE_PARAMS_BYTES);
        writeCoreParams(stageParams, stageParamsStaging);
        stageParamsBuffer = device.createBuffer({
          label: `coreParams:${stage.name}`,
          size: CORE_PARAMS_BYTES,
          usage: gpuBufferUsage.UNIFORM | gpuBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(stageParamsBuffer, 0, stageParamsStaging);
        perStageParamsBuffers.push(stageParamsBuffer);

        // Port `consumeSpatialRadius(xRadius)` hulu -- dipanggil SETELAH
        // tahap ini (yaitu berlaku mulai tahap BERIKUTNYA), persis
        // `SpektraVulkanRenderer.cpp`'s tujuh call-site (:6444-6604), yang
        // semuanya muncul SETELAH dispatch efek terkait, bukan sebelumnya.
        remainingSpatialRadius = Math.max(0, remainingSpatialRadius - resolveSpatialRadius(stage, params, frame));
      }

      stage.encode(encoder, {
        device,
        params: stageParams,
        frame,
        paramsBuffer: stageParamsBuffer,
        source: front,
        dest: back,
        scratch: (label, scratchBytes) => this.scratch(label, scratchBytes),
      });
      // Ping-pong: keadaan yang baru ditulis tahap ini (ke `dest`/`back`)
      // menjadi `source` tahap berikutnya. Menghilangkan baris ini membuat
      // setiap tahap membaca ulang buffer masukan asli yang tak tersentuh —
      // graph.test.ts membuktikan ini lewat tahap yang MENGUBAH nilai
      // (bukan sekadar menyalinnya), sehingga hasil akhir yang salah
      // benar-benar terlihat, bukan cuma kebetulan identik dengan input.
      [front, back] = [back, front];
    }

    const readback = device.createBuffer({
      label: 'readback',
      size: bytes,
      usage: gpuBufferUsage.COPY_DST | gpuBufferUsage.MAP_READ,
    });
    encoder.copyBufferToBuffer(front, 0, readback, 0, bytes);
    device.queue.submit([encoder.finish()]);

    await readback.mapAsync(gpuMapMode.READ);
    const result = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();

    readback.destroy();
    paramsBuffer.destroy();
    for (const buffer of perStageParamsBuffers) buffer.destroy();
    front.destroy();
    back.destroy();

    return result;
  }

  /**
   * Menghancurkan seluruh buffer pada pool scratch. Panggil setelah benar-
   * benar selesai dengan graf ini (mis. akhir sesi render setelah seluruh
   * tile Task 19 selesai) — BUKAN di antara tile, yang justru meniadakan
   * tujuan pool (lih. dokumentasi `StageContext.scratch`). Idempoten.
   */
  dispose(): void {
    if (this.#disposed) return;
    for (const buffer of this.pool.values()) buffer.destroy();
    this.pool.clear();
    this.#disposed = true;
  }
}
