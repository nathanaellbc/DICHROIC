import { describe, it, expect } from 'vitest';
import { acquireDevice } from '../src/engine/device';
import { RenderGraph, ScratchPool } from '../src/engine/graph';
import type { Stage, StageContext } from '../src/engine/graph';
import { createMaterializeActiveRegionStage } from '../src/engine/stages/materializeActiveRegion';
import { Tap } from '../src/engine/taps';
import type { TapName } from '../src/engine/taps';
import type { CoreParams } from '../src/engine/params';
import { gpuBufferUsage } from '../src/engine/webgpuGlobals';

function paramsFor(width: number, height: number): CoreParams {
  return paramsForRegion(width, height, 0, 0, width, height);
}

/**
 * Seperti `paramsFor`, tapi dengan region aktif yang bisa diatur bebas —
 * dibutuhkan untuk menguji `materializeActiveRegion` dengan region yang
 * BENAR-BENAR ter-crop (origin bukan nol, ukuran lebih kecil dari buffer),
 * bukan hanya kasus "region aktif == seluruh buffer" yang paramsFor tutup.
 */
function paramsForRegion(
  width: number,
  height: number,
  activeOriginX: number,
  activeOriginY: number,
  activeWidth: number,
  activeHeight: number,
): CoreParams {
  return {
    width, height,
    filmExposureEv: 0, filmGamma: 1,
    exposureCount: 0, inputColorSpace: 0, rgbToRawMethod: 0,
    colorSpaceCount: 0, transferLutSize: 0,
    colorDecodeMin: 0, colorDecodeMax: 1,
    hanatosWidth: 192, hanatosHeight: 192,
    slot0: 0, slot1: 0, slot2: 0,
    filmPushPullMode: 0, filmPushPullStops: 0,
    fullWidth: width, fullHeight: height,
    tileOriginX: 0, tileOriginY: 0,
    activeOriginX, activeOriginY,
    activeWidth, activeHeight,
  };
}

/**
 * Shader uji minimal: `dst[i] = src[i] + delta`. Tidak berkaitan dengan
 * shader produksi apa pun — tujuannya SEMATA membuktikan mekanika graf
 * (ping-pong benar-benar menukar, `run()` memilih tahap TERAKHIR yang
 * menulis tap), bukan menguji suatu tahap pipeline nyata.
 *
 * Operasi identitas (seperti materializeActiveRegion) tidak bisa membuktikan ini:
 * bila swap dihilangkan, `front` tetap menunjuk buffer masukan asli yang
 * TAK TERSENTUH — dan untuk operasi identitas, buffer tak tersentuh itu
 * kebetulan berisi nilai yang sama persis dengan yang seharusnya ditulis.
 * Tes akan lulus walau swap-nya rusak. Delta bukan-nol tidak punya
 * kebetulan itu: keluaran yang salah akan benar-benar terlihat salah.
 */
const INCREMENT_WGSL = `
struct IncParams {
  count: u32,
  delta: f32,
}

@group(0) @binding(0) var<storage, read> src: array<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<uniform> p: IncParams;

@compute @workgroup_size(256, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= p.count) {
    return;
  }
  dst[gid.x] = src[gid.x] + p.delta;
}
`;

function createIncrementStage(device: GPUDevice, tap: TapName, delta: number): Stage {
  const module = device.createShaderModule({ label: `increment(${delta})`, code: INCREMENT_WGSL });
  const pipeline = device.createComputePipeline({
    label: `increment(${delta})`,
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });

  return {
    name: `increment(${delta})→${tap}`,
    writesTaps: [tap],
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const count = ctx.source.size / Float32Array.BYTES_PER_ELEMENT;
      const uniformBuffer = ctx.device.createBuffer({
        label: `increment(${delta}):params`,
        size: 16,
        usage: gpuBufferUsage.UNIFORM | gpuBufferUsage.COPY_DST,
      });
      const staging = new ArrayBuffer(16);
      const view = new DataView(staging);
      view.setUint32(0, count, true);
      view.setFloat32(4, delta, true);
      ctx.device.queue.writeBuffer(uniformBuffer, 0, staging);

      const bindGroup = ctx.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ctx.source } },
          { binding: 1, resource: { buffer: ctx.dest } },
          { binding: 2, resource: { buffer: uniformBuffer } },
        ],
      });
      const pass = encoder.beginComputePass({ label: `increment(${delta})` });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(count / 256));
      pass.end();
    },
  };
}

/**
 * Tahap identitas (lewat `copyBufferToBuffer`, bukan compute pass) yang JUGA
 * memanggil `ctx.scratch()` dan mencatat referensi buffer yang dikembalikan
 * ke `sink` — semata untuk membuktikan dari LUAR `RenderGraph` bahwa pool
 * scratch-nya memakai ulang objek `GPUBuffer` yang sama untuk label yang
 * sama antar pemanggilan `run()`, bukan sekadar "dimaksudkan" untuk itu.
 */
function createScratchProbeStage(
  tap: TapName,
  sink: GPUBuffer[],
  scratchBytes: () => number,
): Stage {
  return {
    name: `scratchProbe→${tap}`,
    writesTaps: [tap],
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      sink.push(ctx.scratch('probe', scratchBytes()));
      encoder.copyBufferToBuffer(ctx.source, 0, ctx.dest, 0, ctx.source.size);
    },
  };
}

describe('RenderGraph', () => {
  it('membawa piksel utuh melalui materializeActiveRegion', async () => {
    const engine = await acquireDevice();
    const graph = new RenderGraph(engine);
    graph.addStage(createMaterializeActiveRegionStage(engine.device));

    const width = 4;
    const height = 2;
    const input = new Float32Array(width * height * 4);
    for (let i = 0; i < input.length; i += 1) input[i] = i / input.length;

    const output = await graph.run(input, paramsFor(width, height), Tap.RGB_IN);

    expect(output).toHaveLength(input.length);
    for (let i = 0; i < input.length; i += 1) {
      expect(output[i]!, `elemen ${i}`).toBeCloseTo(input[i]!, 6);
    }
    graph.dispose();
  });

  it('melempar galat untuk tap yang tidak ditulis tahap mana pun', async () => {
    const engine = await acquireDevice();
    const graph = new RenderGraph(engine);
    graph.addStage(createMaterializeActiveRegionStage(engine.device));

    await expect(
      graph.run(new Float32Array(16), paramsFor(2, 2), Tap.CMY_FILM),
    ).rejects.toThrow(/cmy_film/);
    graph.dispose();
  });

  it('melempar galat yang menyebut tap saat TIDAK ADA tahap terdaftar', async () => {
    const engine = await acquireDevice();
    const graph = new RenderGraph(engine);

    await expect(
      graph.run(new Float32Array(16), paramsFor(2, 2), Tap.RGB_IN),
    ).rejects.toThrow(/rgb_in/);
  });

  it('menjalankan SETIAP tahap sampai penulis TERAKHIR tap yang diminta, lewat ping-pong yang benar', async () => {
    const engine = await acquireDevice();
    const graph = new RenderGraph(engine);

    // Tiga tahap berantai: A menulis rgb_in, B menulis tap LAIN (cmy_film)
    // tapi tetap harus berjalan karena berada SEBELUM penulis terakhir, C
    // menulis rgb_in lagi. Meminta rgb_in harus menjalankan A, B, DAN C —
    // bila run() memakai findIndex (kecocokan pertama) alih-alih
    // findLastIndex, graf akan berhenti di A dan C tidak akan pernah
    // berjalan. Delta non-nol yang berantai (lih. INCREMENT_WGSL) membuat
    // kedua kegagalan itu (berhenti terlalu awal, swap hilang) menghasilkan
    // angka yang terukur salah, bukan kebetulan benar.
    graph.addStage(createIncrementStage(engine.device, Tap.RGB_IN, 1));
    graph.addStage(createIncrementStage(engine.device, Tap.CMY_FILM, 10));
    graph.addStage(createIncrementStage(engine.device, Tap.RGB_IN, 100));

    const width = 4;
    const height = 2;
    const input = new Float32Array(width * height * 4);
    for (let i = 0; i < input.length; i += 1) input[i] = i;

    const output = await graph.run(input, paramsFor(width, height), Tap.RGB_IN);

    expect(output).toHaveLength(input.length);
    for (let i = 0; i < input.length; i += 1) {
      // 1 (A) + 10 (B) + 100 (C) = 111 bila ketiganya berjalan berantai
      // lewat ping-pong yang benar. findIndex-pertama akan berhenti di A
      // (hasil +1 saja); swap yang hilang akan membuat B dan C membaca
      // ulang `input` asli tanpa efek A yang terlihat.
      expect(output[i]!, `elemen ${i}`).toBeCloseTo(input[i]! + 111, 4);
    }
    graph.dispose();
  });

  it('pool scratch memakai ulang buffer berlabel sama ANTAR pemanggilan run(), dan membesar saat diminta lebih besar', async () => {
    const engine = await acquireDevice();
    const graph = new RenderGraph(engine);
    const sink: GPUBuffer[] = [];
    let requestedBytes = 64;
    graph.addStage(createScratchProbeStage(Tap.RGB_IN, sink, () => requestedBytes));

    const width = 2;
    const height = 2;
    const input = new Float32Array(width * height * 4).fill(0.5);
    const params = paramsFor(width, height);

    await graph.run(input, params, Tap.RGB_IN);
    await graph.run(input, params, Tap.RGB_IN);
    expect(sink).toHaveLength(2);
    // Permintaan berukuran sama pada label yang sama, antar run() TERPISAH,
    // harus mengembalikan OBJEK GPUBuffer yang SAMA — bukan cuma buffer baru
    // yang "kebetulan" berukuran sama. Ini yang membuktikan pool berumur
    // selama RenderGraph, bukan dibuang di akhir setiap run() (bug yang
    // draf awal tugas ini punya: pool dihancurkan+dikosongkan tiap run()
    // kembali, yang meniadakan seluruh tujuan pooling untuk tiling Task 19).
    expect(sink[1]).toBe(sink[0]);

    requestedBytes = 4096;
    await graph.run(input, params, Tap.RGB_IN);
    expect(sink).toHaveLength(3);
    // Permintaan lebih besar pada label yang sama HARUS membesarkan pool
    // (buffer baru), bukan mengembalikan buffer lama yang terlalu kecil.
    expect(sink[2]).not.toBe(sink[1]);
    expect(sink[2]!.size).toBeGreaterThanOrEqual(4096);

    graph.dispose();
  });

  it('materializeActiveRegion menyalin HANYA region aktif yang di-crop, meninggalkan piksel luar tak tersentuh', async () => {
    const engine = await acquireDevice();
    const graph = new RenderGraph(engine);
    graph.addStage(createMaterializeActiveRegionStage(engine.device));

    // Buffer 6x4 (24 piksel); region aktif adalah sub-rektangel 3x2 pada
    // origin (2, 1) — BUKAN seluruh buffer. activeOrigin + activeWidth
    // (2+3=5 <= 6) dan activeOrigin + activeHeight (1+2=3 <= 4) tetap di
    // dalam batas, jadi ini menguji crop itu sendiri, bukan penjaga batas.
    const width = 6;
    const height = 4;
    const activeOriginX = 2;
    const activeOriginY = 1;
    const activeWidth = 3;
    const activeHeight = 2;
    const params = paramsForRegion(width, height, activeOriginX, activeOriginY, activeWidth, activeHeight);

    // Setiap piksel diberi nilai berbeda (indeks liniernya sendiri, di
    // keempat komponen) sehingga "disalin dengan benar" dan "kebetulan nol"
    // tidak bisa tertukar secara diam-diam.
    const input = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x;
        for (let c = 0; c < 4; c += 1) input[pixelIndex * 4 + c] = pixelIndex;
      }
    }

    const output = await graph.run(input, params, Tap.RGB_IN);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x;
        const insideActiveRegion =
          x >= activeOriginX &&
          x < activeOriginX + activeWidth &&
          y >= activeOriginY &&
          y < activeOriginY + activeHeight;
        for (let c = 0; c < 4; c += 1) {
          const value = output[pixelIndex * 4 + c]!;
          if (insideActiveRegion) {
            // Di dalam region: disalin dari sumber, jadi sama dengan input.
            expect(value, `piksel (${x},${y}) komponen ${c}, DI DALAM region`).toBeCloseTo(
              pixelIndex,
              6,
            );
          } else {
            // Di luar region: buffer tujuan baru dan zero-initialized
            // menurut spesifikasi WebGPU (lih. GPUDevice.createBuffer) —
            // shader mengembalikan lebih dulu untuk piksel ini, jadi nilai
            // yang bertahan HARUS nol, bukan nilai piksel input yang bocor
            // dari luar region (yang akan lolos kalau indeksnya salah).
            expect(value, `piksel (${x},${y}) komponen ${c}, DI LUAR region`).toBe(0);
          }
        }
      }
    }
    graph.dispose();
  });

  it('activeWidth/activeHeight == 0 berarti seluruh buffer, BUKAN nol piksel (konvensi hulu)', async () => {
    const engine = await acquireDevice();
    const graph = new RenderGraph(engine);
    graph.addStage(createMaterializeActiveRegionStage(engine.device));

    const width = 4;
    const height = 3;
    // activeWidth/activeHeight sengaja 0 — SpektraCurveDevelop.comp:231-232
    // dan SpektraFilmExposure.comp:232-233 keduanya membaca 0 sebagai
    // "seluruh buffer". Bila shader/dispatch di sini memakai literal 0
    // apa adanya (bukan diselesaikan ke width/height dulu), TIDAK ADA
    // piksel yang akan disalin sama sekali.
    const params = paramsForRegion(width, height, 0, 0, 0, 0);

    const input = new Float32Array(width * height * 4);
    for (let i = 0; i < input.length; i += 1) input[i] = i + 1; // tidak ada yang nol secara alami

    const output = await graph.run(input, params, Tap.RGB_IN);

    for (let i = 0; i < input.length; i += 1) {
      expect(output[i]!, `elemen ${i}`).toBeCloseTo(input[i]!, 6);
    }
    graph.dispose();
  });

  it('Penjaga 2 mencegah row-wrap: activeOrigin+activeWidth > width TIDAK beraliasing ke piksel baris berikutnya', async () => {
    const engine = await acquireDevice();
    const graph = new RenderGraph(engine);
    graph.addStage(createMaterializeActiveRegionStage(engine.device));

    // Buffer 6x4 (24 piksel). Region aktif: origin (4,0), lebar 3, tinggi 1 —
    // activeOriginX + activeWidth = 4+3 = 7 > width (6). Lokal x=2 menghasilkan
    // absoluteX=6, yang TIDAK melampaui TOTAL buffer (index linear 6 = piksel
    // (0,1), valid dalam 24 piksel) — ini BUKAN kasus out-of-bounds genuinely
    // di luar buffer (implementation-defined, tidak dites di sini). Ini
    // row-wrap: tanpa Penjaga 2, thread itu menghitung index = 0*6+6 = 6 dan
    // menulis dst[6] = src[6], memberi piksel (0,1) NILAI ASLINYA SENDIRI —
    // walau piksel itu sama sekali bukan bagian region aktif dan seharusnya
    // tetap nol (zero-initialized, tak tersentuh). Ini deterministik dan
    // sama di semua backend (BUKAN "menyalin-ulang nilai yang tetap benar" —
    // piksel (0,1) tidak pernah seharusnya disalin sama sekali), berbeda
    // dari alasan yang laporan Task 9 sebelumnya salah-generalisasi ke
    // kasus ini juga.
    const width = 6;
    const height = 4;
    const activeOriginX = 4;
    const activeOriginY = 0;
    const activeWidth = 3;
    const activeHeight = 1;
    const params = paramsForRegion(
      width,
      height,
      activeOriginX,
      activeOriginY,
      activeWidth,
      activeHeight,
    );

    const input = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x;
        for (let c = 0; c < 4; c += 1) input[pixelIndex * 4 + c] = pixelIndex + 1;
      }
    }

    const output = await graph.run(input, params, Tap.RGB_IN);

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixelIndex = y * width + x;
        // Hanya (4,0) dan (5,0) benar-benar di dalam region DAN di dalam
        // buffer — (6,0) yang diminta local x=2 tidak ada secara fisik.
        const insideActiveRegion =
          x >= activeOriginX &&
          x < Math.min(activeOriginX + activeWidth, width) &&
          y >= activeOriginY &&
          y < activeOriginY + activeHeight;
        for (let c = 0; c < 4; c += 1) {
          const value = output[pixelIndex * 4 + c]!;
          if (insideActiveRegion) {
            expect(value, `piksel (${x},${y}) komponen ${c}, DI DALAM region`).toBeCloseTo(
              pixelIndex + 1,
              6,
            );
          } else {
            // Termasuk piksel (0,1) [indeks linear 6] -- target row-wrap
            // yang Penjaga 2 harus cegah. Kalau nilainya bukan nol di sini,
            // Penjaga 2 tidak bekerja dan test ini memerah.
            expect(value, `piksel (${x},${y}) komponen ${c}, DI LUAR region (row-wrap)`).toBe(0);
          }
        }
      }
    }
    graph.dispose();
  });

  it('run() setelah dispose() melempar galat yang menyebut solusinya, bukan diam-diam membangun ulang pool dari kosong', async () => {
    const engine = await acquireDevice();
    const graph = new RenderGraph(engine);
    graph.addStage(createMaterializeActiveRegionStage(engine.device));

    const params = paramsFor(2, 2);
    const input = new Float32Array(2 * 2 * 4).fill(0.25);

    // Sekali sebelum dispose() harus lancar seperti biasa.
    await expect(graph.run(input, params, Tap.RGB_IN)).resolves.toHaveLength(input.length);

    graph.dispose();

    // Tanpa pemeriksaan ini, run() setelah dispose() TIDAK gagal, TIDAK
    // merusak apa pun, dan menghasilkan piksel yang benar -- sambil diam-diam
    // membangun ulang pool scratch dari Map kosong setiap panggilan. Itu
    // persis mode kegagalan multiplikasi VRAM yang pool itu ada untuk
    // mencegah, dan tidak akan terlihat sama sekali karena keluarannya benar.
    await expect(graph.run(input, params, Tap.RGB_IN)).rejects.toThrow(/dispose/);
    await expect(graph.run(input, params, Tap.RGB_IN)).rejects.toThrow(/RenderGraph baru/);
  });

  it('scratch dibagi antar tahap: memori pool = tahap terbesar, bukan jumlah semua tahap', async () => {
    const engine = await acquireDevice();
    const pool = new ScratchPool(engine.device);
    const graph = new RenderGraph(engine, pool);
    const first: GPUBuffer[] = [];
    const second: GPUBuffer[] = [];
    graph.addStage(createScratchProbeStage(Tap.RGB_IN, first, () => 256));
    // Tahap kedua butuh scratch LEBIH BESAR: slot dibesarkan di tengah encode,
    // dan buffer lama (sudah dirujuk perintah tahap pertama) tidak boleh
    // dihancurkan sebelum submit -- run tetap valid dan hasilnya benar.
    graph.addStage(createScratchProbeStage(Tap.RGB_OUT, second, () => 1024));
    const params = paramsFor(2, 2);
    const input = new Float32Array(2 * 2 * 4).map((_, i) => i);

    await expect(graph.run(input, params, Tap.RGB_OUT)).resolves.toEqual(input);
    expect(pool.bytes).toBe(1024);

    // Run kedua: kedua tahap memakai buffer YANG SAMA (slot sudah cukup besar).
    await graph.run(input, params, Tap.RGB_OUT);
    expect(first[1]).toBe(second[1]);
    expect(pool.bytes).toBe(1024);

    // Graf lain dengan pool yang sama tidak menambah memori.
    const other = new RenderGraph(engine, pool);
    other.addStage(createScratchProbeStage(Tap.RGB_OUT, [], () => 512));
    await other.run(input, params, Tap.RGB_OUT);
    expect(pool.bytes).toBe(1024);

    pool.release();
    expect(pool.bytes).toBe(0);
    graph.dispose();
    other.dispose();
  });

  it('output rgb mengemas 3 kanal langsung dari readback', async () => {
    const engine = await acquireDevice();
    const graph = new RenderGraph(engine);
    graph.addStage(createMaterializeActiveRegionStage(engine.device));
    const params = paramsFor(2, 1);
    const input = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(graph.run(input, params, Tap.RGB_IN, { output: 'rgb' })).resolves.toEqual(new Float32Array([1, 2, 3, 5, 6, 7]));
    graph.dispose();
  });

  it('melempar galat sinkron saat ukuran input tidak cocok dengan params, bukan peringatan validasi WebGPU asinkron', async () => {
    const engine = await acquireDevice();
    const graph = new RenderGraph(engine);
    graph.addStage(createMaterializeActiveRegionStage(engine.device));

    // paramsFor(4, 2) mengimplikasikan 4*2*4 = 32 float = 128 byte.
    const params = paramsFor(4, 2);
    const wrongSizedInput = new Float32Array(16); // 64 byte, bukan 128.

    await expect(graph.run(wrongSizedInput, params, Tap.RGB_IN)).rejects.toThrow(/128/);
    await expect(graph.run(wrongSizedInput, params, Tap.RGB_IN)).rejects.toThrow(/64/);
    graph.dispose();
  });
});
