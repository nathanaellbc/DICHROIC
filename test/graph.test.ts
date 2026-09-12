import { describe, it, expect } from 'vitest';
import { acquireDevice } from '../src/engine/device';
import { RenderGraph } from '../src/engine/graph';
import type { Stage, StageContext } from '../src/engine/graph';
import { createMaterializeActiveRegionStage } from '../src/engine/stages/materializeActiveRegion';
import { Tap } from '../src/engine/taps';
import type { TapName } from '../src/engine/taps';
import type { CoreParams } from '../src/engine/params';

/**
 * `GPUBufferUsage` tidak dipasang di Node/Vitest (lih. komentar `arena.ts`
 * dan `graph.ts`) — dibutuhkan di sini untuk membangun tahap uji yang tidak
 * termasuk kode produksi (increment/probe di bawah).
 */
const gpuBufferUsage: typeof GPUBufferUsage =
  typeof GPUBufferUsage !== 'undefined'
    ? GPUBufferUsage
    : (
        (await import('webgpu')) as unknown as {
          globals: { GPUBufferUsage: typeof GPUBufferUsage };
        }
      ).globals.GPUBufferUsage;

function paramsFor(width: number, height: number): CoreParams {
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
    activeOriginX: 0, activeOriginY: 0,
    activeWidth: width, activeHeight: height,
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
});
