import { afterEach, describe, expect, it, vi } from 'vitest';
import { zlibSync } from 'fflate';
import { encode } from 'fast-png';
import { decodePng } from '../../src/io/png';
import { inflateBounded } from '../../src/io/inflateBounded';
import { assertImageBudget, imageMemoryBudget, IMAGE_RGBA_BUDGET } from '../../src/io/budget';
import { decodeTiff } from '../../src/io/tiff';
import { buildTiff, RGB_TAGS, type Entry } from './tiffBuilder';

afterEach(() => vi.unstubAllGlobals());

function header(patch: Entry[]) {
  const entries = [...RGB_TAGS, { tag: 277, type: 3 as const, values: [3] },
    { tag: 273, type: 4 as const, values: [0] }, { tag: 279, type: 4 as const, values: [1] }];
  return buildTiff([...entries.filter((e) => !patch.some((p) => p.tag === e.tag)), ...patch]);
}

describe('decoder allocation limits', () => {
  it('rejects a tiny PNG that expands beyond its declared pixels', () => {
    const base = encode({ width: 1, height: 1, data: Uint8Array.of(0, 0, 0), channels: 3, depth: 8 });
    const payload = zlibSync(new Uint8Array(100_000));
    const bytes = new Uint8Array(33 + 12 + payload.length + 12);
    bytes.set(base.subarray(0, 33));
    new DataView(bytes.buffer).setUint32(33, payload.length);
    bytes.set([73, 68, 65, 84], 37); bytes.set(payload, 41);
    bytes.set(base.subarray(base.length - 12), 45 + payload.length);
    expect(() => decodePng(bytes)).toThrow(/PNG expansion.*memory limit/);
  });

  it('rejects oversized compressed metadata without retaining its expansion', () => {
    expect(() => inflateBounded(zlibSync(new Uint8Array(100_000)), 1024)).toThrow(/memory limit/);
  });

  it('rejects oversized and nonintegral dimensions', () => {
    expect(() => assertImageBudget(100000, 10000)).toThrow(/memory limit/);
    expect(() => assertImageBudget(1.5, 2)).toThrow(/memory limit/);
    expect(() => assertImageBudget(6000, 4000)).not.toThrow();
  });

  it('admits native 24 and 48 MP sources on desktop without removing the ceiling', () => {
    vi.stubGlobal('navigator', { userAgent: 'Desktop', deviceMemory: 8 });
    for (const bytesPerPixel of [16, 20, 22, 24, 32]) {
      expect(() => assertImageBudget(6000, 4000, bytesPerPixel)).not.toThrow();
      expect(() => assertImageBudget(8064, 6048, bytesPerPixel)).not.toThrow();
    }
    expect(() => assertImageBudget(8144, 5424, 32)).not.toThrow(); // Reported JPEG.
    expect(() => assertImageBudget(5120, 7168, 22)).not.toThrow(); // Reported RGB16 ARW.
    expect(() => assertImageBudget(5120, 7168, 16, imageMemoryBudget() - 8144 * 5424 * 16)).not.toThrow();
    // Replacing a 48 MP source retains both Float32 images until success.
    expect(() => assertImageBudget(8064, 6048, 16, imageMemoryBudget() - 8064 * 6048 * 16)).not.toThrow();
    expect(() => assertImageBudget(10000, 8000, 32)).toThrow(/memory limit/);
  });

  it.each([
    [{ deviceMemory: 2 }, 512],
    [{ deviceMemory: 4 }, 1024],
    [{ deviceMemory: 8 }, 2048],
    [{ userAgent: 'iPhone' }, 1024],
    [{ userAgent: 'Macintosh', maxTouchPoints: 5 }, 1024],
    [{ userAgent: 'Desktop' }, 2048],
    [{ deviceMemory: 0, userAgent: 'Desktop' }, 2048],
  ])('uses a bounded budget for device %j', (navigator, mib) => {
    vi.stubGlobal('navigator', navigator);
    expect(imageMemoryBudget()).toBe(mib * 1024 * 1024);
  });

  it('honours a smaller explicit budget and rejects invalid allocation estimates', () => {
    expect(() => assertImageBudget(8000, 6000, 16, 512 * 1024 * 1024)).toThrow(/memory limit/);
    expect(() => assertImageBudget(1, 1, -1)).toThrow(/memory limit/);
    expect(() => assertImageBudget(1, 1, Infinity)).toThrow(/memory limit/);
    expect(imageMemoryBudget()).toBe(IMAGE_RGBA_BUDGET);
  });

  it.each([
    { patch: [{ tag: 277, type: 3 as const, values: [64] }] },
    { patch: [{ tag: 256, type: 4 as const, values: [100000] }, { tag: 257, type: 4 as const, values: [10000] }] },
    { patch: [{ tag: 256, type: 4 as const, values: [2048] }, { tag: 257, type: 4 as const, values: [2048] }] },
  ])('rejects hostile TIFF headers before a full image allocation', ({ patch }) => {
    const allocate = vi.fn(() => { throw new Error('unexpected full image allocation'); });
    vi.stubGlobal('Float32Array', allocate);
    expect(() => decodeTiff(header(patch))).toThrow(/SamplesPerPixel|memory limit|batas|terpotong/);
    expect(allocate).not.toHaveBeenCalled();
  });

  it('bounds Deflate expansion to the declared strip size', () => {
    const payload = zlibSync(new Uint8Array(100_000));
    const entries: Entry[] = [
      { tag: 256, type: 4, values: [1] }, { tag: 257, type: 4, values: [1] },
      { tag: 259, type: 3, values: [8] }, { tag: 279, type: 4, values: [payload.length] },
    ];
    const preliminary = header(entries);
    const h = header([...entries, { tag: 273, type: 4, values: [preliminary.length] }]);
    const bytes = new Uint8Array(h.length + payload.length); bytes.set(h); bytes.set(payload, h.length);
    expect(() => decodeTiff(bytes)).toThrow(/Deflate length/);
  });
});
