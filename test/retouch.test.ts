import { describe, expect, it } from 'vitest';
import { applyRemoval, prepareRemoval, restoreRemoval } from '../src/retouch/patch';
import type { DecodedImage } from '../src/io/decoded';

function image(encoding: 'linear' | 'encoded' = 'encoded'): DecodedImage {
  const rgba = new Float32Array(64 * 64 * 4).fill(0.3);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 1;
  return { width: 64, height: 64, rgba, suggestedColorSpace: encoding === 'linear' ? 'Linear Rec.709' : 'sRGB', encoding, source: { format: 'fixture', bitDepth: 32 } };
}
const selection = () => {
  const data = new Uint8Array(64 * 64);
  for (let y = 26; y < 38; y++) for (let x = 26; x < 38; x++) data[y * 64 + x] = 1;
  return { width: 64, height: 64, data };
};
describe('LaMa source patches', () => {
  it('keeps unmasked pixels and alpha exactly, restores all native floats on undo', () => {
    const photo = image(), before = photo.rgba.slice();
    const crop = prepareRemoval(photo, selection(), 7);
    expect(crop.revision).toBe(7);
    const backup = applyRemoval(photo, crop, new Float32Array(512 * 512 * 3).fill(0.8));
    expect(backup.length).toBeLessThan(crop.width * crop.height * 3);
    expect(photo.rgba[(32 * 64 + 32) * 4]).toBeCloseTo(0.8);
    expect(Array.from(photo.rgba.slice(0, 4))).toEqual(Array.from(before.slice(0, 4)));
    for (let i = 3; i < photo.rgba.length; i += 4) expect(photo.rgba[i]).toBe(1);
    restoreRemoval(photo, crop, backup);
    expect(photo.rgba).toEqual(before);
  });
  it('encodes linear RAW for the model and decodes generated pixels back to linear', () => {
    const photo = image('linear');
    const crop = prepareRemoval(photo, selection(), 1);
    expect(crop.rgb[0]).toBeCloseTo(0.5838315);
    applyRemoval(photo, crop, new Float32Array(512 * 512 * 3).fill(0.5));
    expect(photo.rgba[(32 * 64 + 32) * 4]).toBeCloseTo(0.214041);
    expect(photo.encoding).toBe('linear');
  });
  it('rejects empty masks, invalid results and invalid source dimensions without mutating the source', () => {
    const photo = image(), before = photo.rgba.slice();
    expect(() => prepareRemoval(photo, { width: 64, height: 64, data: new Uint8Array(4096) }, 1)).toThrow('Brush');
    const crop = prepareRemoval(photo, selection(), 1);
    expect(() => applyRemoval(photo, crop, Float32Array.of(NaN))).toThrow('Invalid');
    expect(photo.rgba).toEqual(before);
    expect(() => prepareRemoval({ ...photo, width: 8000, height: 8000 }, { width: 1, height: 1, data: Uint8Array.of(1) }, 1)).toThrow('Invalid removal source');
  });
  it('prepares large selections using the same bounded model buffers', () => {
    const photo = { ...image(), width: 2304, height: 2048, rgba: new Float32Array(2304 * 2048 * 4) };
    const crop = prepareRemoval(photo, { width: 1, height: 1, data: Uint8Array.of(1) }, 1);
    expect(crop.width * crop.height).toBeGreaterThan(4_194_304);
    expect(crop.rgb.length).toBe(512 * 512 * 3);
    expect(crop.mask.length).toBe(512 * 512);
  });
  it('does not silently flatten unsupported source color spaces', () => {
    expect(() => prepareRemoval({ ...image(), suggestedColorSpace: 'Display P3' }, selection(), 1)).toThrow('color spaces');
  });
});
