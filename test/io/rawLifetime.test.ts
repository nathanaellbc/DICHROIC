import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ open: vi.fn(), imageData: vi.fn(), delete: vi.fn() }));
vi.mock('libraw-wasm/dist/libraw.js', () => ({ default: async () => ({ LibRaw: class {
  open = native.open; imageData = native.imageData; delete = native.delete;
} }) }));
import { decodeRaw } from '../../src/io/raw';

beforeEach(() => vi.resetAllMocks());

describe('RAW native lifetime', () => {
  it('copies the pixels before destroying the native decoder', async () => {
    const data = Uint16Array.of(65535, 0, 0);
    native.imageData.mockReturnValue({ width: 1, height: 1, colors: 3, bits: 16, data });
    native.delete.mockImplementation(() => data.fill(0));
    const image = await decodeRaw(new Uint8Array(1));
    expect(image.rgba[0]).toBeGreaterThan(0.99);
    expect(Array.from(image.rgba.slice(1))).toEqual([0, 0, 1]);
    expect(native.delete).toHaveBeenCalledOnce();
  });
  it('destroys the decoder after a native open error', async () => {
    native.open.mockImplementation(() => { throw new Error('bad RAW'); });
    await expect(decodeRaw(new Uint8Array(1))).rejects.toThrow('bad RAW');
    expect(native.delete).toHaveBeenCalledOnce();
  });
  it('destroys the decoder after image validation rejects the result', async () => {
    native.imageData.mockReturnValue({ width: 1, height: 1, colors: 3, bits: 8, data: new Uint8Array(3) });
    await expect(decodeRaw(new Uint8Array(1))).rejects.toThrow('bukan 16-bit');
    expect(native.delete).toHaveBeenCalledOnce();
  });
});
