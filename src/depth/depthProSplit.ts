/**
 * Depth Pro versi HP (`DEPTH_MODELS.pro`): ekspor `apple/DepthPro-hf` tanpa
 * kepala FOV, dipecah jadi tiga sesi ONNX q4f16 yang dijalankan BERGANTIAN --
 * hanya satu bagian bobot di memori pada satu waktu, dan 35 potongan patch
 * encoder diproses `PATCH_CHUNK` sekaligus (memori atensi ikut kecil):
 *
 *   image    pixel_values [1,3,1536,1536]           -> image_hidden [1,577,1024]
 *   patch    pixel_values, index [K] (int64)        -> last, inter_a, inter_b [K,577,1024]
 *   decoder  last [35,..], inter_a/inter_b [25,..], image_hidden -> inverse_depth [1,1536,1536]
 *
 * Semua I/O fp16. Keluaran: inverse depth kanonis (makin dekat makin besar),
 * jadi langsung disparitas untuk refine dan lens blur.
 */
import type * as Ort from 'onnxruntime-web';

export const DEPTH_PRO_SIZE = 1536;
export const PATCH_COUNT = 35;
/** Potongan resolusi tinggi pertama: hanya mereka yang dipakai fitur antara (inter_a/inter_b). */
export const HIGH_RES_PATCHES = 25;
export const PATCH_CHUNK = 5;
const TOKENS = 577 * 1024;

export type DepthProStage = 'image' | 'patch' | 'decoder';

/** float32 -> bit fp16 (round-to-nearest-even, subnormal, inf/NaN). */
export function toHalf(src: Float32Array): Uint16Array {
  const out = new Uint16Array(src.length);
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  for (let i = 0; i < src.length; i += 1) {
    f[0] = src[i]!;
    const x = u[0]!;
    const sign = (x >>> 16) & 0x8000;
    const exp = (x >>> 23) & 0xff;
    let mant = x & 0x7fffff;
    if (exp === 0xff) { out[i] = sign | 0x7c00 | (mant ? 0x200 : 0); continue; }
    let e = exp - 127 + 15;
    if (e >= 0x1f) { out[i] = sign | 0x7c00; continue; }
    if (e <= 0) {
      if (e < -10) { out[i] = sign; continue; }
      mant |= 0x800000;
      const shift = 14 - e;
      let h = mant >>> shift;
      const rem = mant & ((1 << shift) - 1);
      const half = 1 << (shift - 1);
      if (rem > half || (rem === half && (h & 1))) h += 1;
      out[i] = sign | h;
      continue;
    }
    let h = (e << 10) | (mant >>> 13);
    const rem = mant & 0x1fff;
    if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h += 1; // carry boleh naik ke eksponen
    e = h >>> 10;
    out[i] = sign | (e >= 0x1f ? 0x7c00 : h);
  }
  return out;
}

/** bit fp16 -> float32. */
export function fromHalf(src: Uint16Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 1) {
    const h = src[i]!;
    const sign = h & 0x8000 ? -1 : 1;
    const exp = (h >>> 10) & 0x1f;
    const mant = h & 0x3ff;
    out[i] = exp === 0 ? sign * mant * 2 ** -24 : exp === 0x1f ? (mant ? NaN : sign * Infinity) : sign * (1 + mant / 1024) * 2 ** (exp - 15);
  }
  return out;
}

/** Data tensor fp16 sebagai bit, baik ORT mengembalikan Uint16Array maupun Float16Array. */
function halfBits(data: unknown): Uint16Array {
  if (data instanceof Uint16Array) return data;
  const F16 = (globalThis as { Float16Array?: new (n: number) => ArrayLike<number> }).Float16Array;
  if (F16 && data instanceof F16) return new Uint16Array((data as unknown as { buffer: ArrayBuffer; byteOffset: number; length: number }).buffer, (data as unknown as { byteOffset: number }).byteOffset, (data as unknown as { length: number }).length);
  throw new Error('Depth Pro: expected a float16 tensor.');
}

export interface DepthProRun {
  /** Buka sesi satu tahap (unduh/cache, kompilasi). */
  open(stage: DepthProStage): Promise<Ort.InferenceSession>;
  /** Selesai dengan tahap ini: profil memori rendah melepas sesinya. */
  done(stage: DepthProStage, session: Ort.InferenceSession): Promise<void>;
  onStep?(done: number, total: number): void;
}

/** Jalankan ketiga tahap. `pixels`: tensor ternormalisasi [3,1536,1536] CHW float32. */
export async function runDepthPro(ort: typeof Ort, pixels: Float32Array, run: DepthProRun): Promise<Float32Array> {
  const size = DEPTH_PRO_SIZE;
  const steps = 2 + Math.ceil(PATCH_COUNT / PATCH_CHUNK);
  let step = 0;
  const tick = () => run.onStep?.(++step, steps);
  const pixelTensor = () => new ort.Tensor('float16', toHalf(pixels), [1, 3, size, size]);

  // Tahap 1: encoder gambar utuh.
  const image = await run.open('image');
  const px = pixelTensor();
  const imageOut = await image.run({ pixel_values: px });
  const imageHidden = halfBits(await imageOut['image_hidden']!.getData()).slice();
  for (const t of Object.values(imageOut)) t.dispose();
  await run.done('image', image);
  tick();

  // Tahap 2: patch encoder, PATCH_CHUNK potongan sekali jalan.
  const last = new Uint16Array(PATCH_COUNT * TOKENS);
  const interA = new Uint16Array(HIGH_RES_PATCHES * TOKENS);
  const interB = new Uint16Array(HIGH_RES_PATCHES * TOKENS);
  const patch = await run.open('patch');
  for (let start = 0; start < PATCH_COUNT; start += PATCH_CHUNK) {
    const k = Math.min(PATCH_CHUNK, PATCH_COUNT - start);
    const index = new ort.Tensor('int64', BigInt64Array.from({ length: k }, (_, i) => BigInt(start + i)), [k]);
    const out = await patch.run({ pixel_values: px, index });
    last.set(halfBits(await out['last']!.getData()), start * TOKENS);
    if (start < HIGH_RES_PATCHES) {
      const keep = Math.min(k, HIGH_RES_PATCHES - start) * TOKENS;
      interA.set(halfBits(await out['inter_a']!.getData()).subarray(0, keep), start * TOKENS);
      interB.set(halfBits(await out['inter_b']!.getData()).subarray(0, keep), start * TOKENS);
    }
    for (const t of Object.values(out)) t.dispose();
    index.dispose();
    tick();
  }
  px.dispose();
  await run.done('patch', patch);

  // Tahap 3: decoder (neck, fusion, head).
  const decoder = await run.open('decoder');
  const feeds = {
    last: new ort.Tensor('float16', last, [PATCH_COUNT, 577, 1024]),
    inter_a: new ort.Tensor('float16', interA, [HIGH_RES_PATCHES, 577, 1024]),
    inter_b: new ort.Tensor('float16', interB, [HIGH_RES_PATCHES, 577, 1024]),
    image_hidden: new ort.Tensor('float16', imageHidden, [1, 577, 1024]),
  };
  const out = await decoder.run(feeds);
  const depth = fromHalf(halfBits(await out['inverse_depth']!.getData()));
  for (const t of [...Object.values(out), ...Object.values(feeds)]) t.dispose();
  await run.done('decoder', decoder);
  tick();
  return depth;
}
