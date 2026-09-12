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

/**
 * `GPUBufferUsage`/`GPUMapMode` adalah GLOBAL bawaan browser, tidak dipasang
 * di Node/Vitest. Mengikuti pola yang sudah ditetapkan `arena.ts` dan
 * `device.ts` (lih. komentar panjang `arena.ts` tentang ini): resolusi SEKALI
 * lewat top-level await saat modul dimuat, turun ke `globals.*` paket
 * `webgpu` (Dawn) bila `globalThis` tidak memilikinya.
 */
const gpuBufferUsage: typeof GPUBufferUsage =
  typeof GPUBufferUsage !== 'undefined'
    ? GPUBufferUsage
    : (
        (await import('webgpu')) as unknown as {
          globals: { GPUBufferUsage: typeof GPUBufferUsage };
        }
      ).globals.GPUBufferUsage;

const gpuMapMode: typeof GPUMapMode =
  typeof GPUMapMode !== 'undefined'
    ? GPUMapMode
    : (
        (await import('webgpu')) as unknown as {
          globals: { GPUMapMode: typeof GPUMapMode };
        }
      ).globals.GPUMapMode;

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

  async run(
    input: Float32Array,
    params: CoreParams,
    collect: TapName,
  ): Promise<Float32Array> {
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
