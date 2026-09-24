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

export interface StageContext {
  device: GPUDevice;
  params: CoreParams;
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
  encode(encoder: GPUCommandEncoder, ctx: StageContext): void;
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
    options?: { maxBufferBytes?: number; overlap?: number },
  ): Promise<Float32Array> {
    const maxBufferBytes = options?.maxBufferBytes;
    if (maxBufferBytes !== undefined) {
      const overlap = options?.overlap ?? 0;
      const tiles = planTiles(params.width, params.height, maxBufferBytes, overlap);
      if (tiles.length > 1) {
        return this.runTiled(input, params, collect, tiles);
      }
    }
    return this.runSingleBuffer(input, params, collect);
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
      const tileResult = await this.runSingleBuffer(tileInput, tileParams, collect);
      stitchTileOutput(output, width, tileResult, tile);
    }

    return output;
  }

  private async runSingleBuffer(
    input: Float32Array,
    params: CoreParams,
    collect: TapName,
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

    const encoder = device.createCommandEncoder({ label: 'graph' });
    for (let i = 0; i <= stopAt; i += 1) {
      this.stages[i]!.encode(encoder, {
        device,
        params,
        paramsBuffer,
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
