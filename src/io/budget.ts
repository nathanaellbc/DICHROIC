/** Cap owned Float32 RGBA storage before allocating decoder output. */
export const IMAGE_RGBA_BUDGET = 512 * 1024 * 1024;
export const IMAGE_BLOCK_BUDGET = 64 * 1024 * 1024;

export function assertImageBudget(width: number, height: number, bytesPerPixel = 16, budget = IMAGE_RGBA_BUDGET): void {
  const bytes = width * height * bytesPerPixel;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      !Number.isSafeInteger(bytes) || bytes > budget) {
    throw new RangeError(`Image ${width}×${height} exceeds the decoding memory limit. Open a smaller version of this photo.`);
  }
}
