import { describe, expect, it } from 'vitest';
import { HIGH_RES_PATCHES, PATCH_CHUNK, PATCH_COUNT, fromHalf, runDepthPro, toHalf } from '../../src/depth/depthProSplit';
import type { DepthProStage } from '../../src/depth/depthProSplit';

describe('Depth Pro terpecah', () => {
  it('fp16: bolak-balik dalam setengah ULP, nilai khusus terjaga', () => {
    const values = Float32Array.from([0, -0, 1, -1, 0.1, 65504, 1e-5, 6e-8, 3.14159, -2.5e-3, Infinity, -Infinity, 1e6]);
    const back = fromHalf(toHalf(values));
    expect(back[10]).toBe(Infinity);
    expect(back[11]).toBe(-Infinity);
    expect(back[12]).toBe(Infinity); // di atas jangkauan fp16
    for (const i of [0, 2, 3, 4, 5, 8, 9]) expect(Math.abs(back[i]! - values[i]!)).toBeLessThanOrEqual(Math.abs(values[i]!) * 2 ** -11 + 1e-7);
    expect(Math.abs(back[6]! - 1e-5)).toBeLessThan(1e-7); // subnormal fp16
    expect(Number.isNaN(fromHalf(toHalf(Float32Array.of(NaN)))[0])).toBe(true);
  });

  it('tahap berurutan, potongan per PATCH_CHUNK, fitur antara hanya 25 potongan pertama', async () => {
    const T = 577 * 1024;
    const calls: string[] = [];
    const tensor = (type: string, data: ArrayLike<unknown>, dims: number[]) => ({ type, data, dims, dispose() {}, getData: async () => data });
    const ort = { Tensor: function (this: unknown, type: string, data: ArrayLike<unknown>, dims: number[]) { return tensor(type, data, dims); } } as never;
    const session = (stage: DepthProStage) => ({
      run: async (feeds: Record<string, { data: ArrayLike<unknown>; dims: number[] }>) => {
        if (stage === 'image') return { image_hidden: tensor('float16', new Uint16Array(T).fill(1), [1, 577, 1024]) };
        if (stage === 'patch') {
          const idx = Array.from(feeds.index!.data as BigInt64Array, Number);
          calls.push(`patch ${idx[0]}-${idx[idx.length - 1]}`);
          const fill = (v: number) => tensor('float16', new Uint16Array(idx.length * T).fill(v), [idx.length, 577, 1024]);
          return { last: fill(idx[0]! + 1), inter_a: fill(idx[0]! + 2), inter_b: fill(idx[0]! + 3) };
        }
        expect(feeds.last!.dims).toEqual([PATCH_COUNT, 577, 1024]);
        expect(feeds.inter_a!.dims).toEqual([HIGH_RES_PATCHES, 577, 1024]);
        // Potongan 30-34 memakai nilai chunk-nya sendiri; fitur antara potongan 20-24 dari chunk 20.
        expect((feeds.last!.data as Uint16Array)[30 * T]).toBe(31);
        expect((feeds.inter_a!.data as Uint16Array)[24 * T]).toBe(22);
        return { inverse_depth: tensor('float16', toHalf(Float32Array.of(0.5, 1.25)), [1, 1, 2]) };
      },
    });
    const opened: string[] = [];
    const depth = await runDepthPro(ort, new Float32Array(3 * 1536 * 1536), {
      open: async (stage) => { opened.push(`open ${stage}`); return session(stage) as never; },
      done: async (stage) => { opened.push(`done ${stage}`); },
    });
    expect(Array.from(depth)).toEqual([0.5, 1.25]);
    expect(opened).toEqual(['open image', 'done image', 'open patch', 'done patch', 'open decoder', 'done decoder']);
    expect(calls).toHaveLength(Math.ceil(PATCH_COUNT / PATCH_CHUNK));
    expect(calls[0]).toBe('patch 0-4');
  });
});
