/** Desktop ceiling for estimated decoder allocations and retained source images. */
export const IMAGE_RGBA_BUDGET = 2 * 1024 * 1024 * 1024;
export const IMAGE_BLOCK_BUDGET = 64 * 1024 * 1024;

/** Available in both the UI and workers; missing RAM hints are not zero RAM. */
export function imageMemoryBudget(): number {
  const device = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  const ram = device?.deviceMemory;
  if (ram !== undefined && Number.isFinite(ram) && ram > 0) {
    if (ram <= 2) return 512 * 1024 * 1024;
    if (ram <= 4) return 1024 * 1024 * 1024;
    return IMAGE_RGBA_BUDGET;
  }
  // Safari does not expose deviceMemory. Keep a lower ceiling on phones/tablets.
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(device?.userAgent ?? '') ||
    (/Macintosh/i.test(device?.userAgent ?? '') && (device?.maxTouchPoints ?? 0) > 1);
  return mobile ? 1024 * 1024 * 1024 : IMAGE_RGBA_BUDGET;
}

export function assertImageBudget(width: number, height: number, bytesPerPixel = 16, budget = imageMemoryBudget()): void {
  const bytes = width * height * bytesPerPixel;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      !Number.isFinite(bytesPerPixel) || bytesPerPixel <= 0 ||
      !Number.isSafeInteger(bytes) || bytes > budget) {
    throw new RangeError(`Image ${width}×${height} exceeds the decoding memory limit. Open a smaller version of this photo.`);
  }
}
