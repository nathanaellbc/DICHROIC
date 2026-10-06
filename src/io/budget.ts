/** Desktop ceiling for estimated decoder allocations and retained source images. */
export const IMAGE_RGBA_BUDGET = 2 * 1024 * 1024 * 1024;
export const IMAGE_BLOCK_BUDGET = 64 * 1024 * 1024;
/** Mobile source-decoding headroom; 48 MP browser-decoded photos exceed it. */
export const MOBILE_IMAGE_BUDGET = 768 * 1024 * 1024;
export const MOBILE_PREVIEW_PIXELS = 1_572_864;

/** Skala anggaran tile terkecil (1/16 dari awal) sebelum ekspor menyerah. */
export const MIN_EXPORT_TILE_SCALE = 1 / 16;

/** Working set GPU per piksel tile ekspor, terukur (lih. `EXPORT_GPU_BYTES_PER_PIXEL`). */
const TILE_BYTES_PER_PIXEL = 192;
/** Buffer terbesar rantai (ping/pong RGBA f32) per piksel. */
const LARGEST_BUFFER_BYTES_PER_PIXEL = 16;

export function clampTileScale(scale: number | undefined): number {
  if (scale === undefined || !Number.isFinite(scale)) return 1;
  return Math.min(1, Math.max(MIN_EXPORT_TILE_SCALE, scale));
}

/**
 * Anggaran GPU satu tile ekspor (`planExportTiles`), adaptif:
 *  - titik awal dari kelas perangkat (HP 384 MB, desktop 640 MB) tapi tidak
 *    melebihi yang diizinkan GPU: buffer ping (16 B/px dari 192) tidak boleh
 *    melewati `maxBufferSize` adapter;
 *  - dikali `scale` hasil belajar: dibagi dua tiap kali GPU kehabisan memori
 *    di tengah ekspor (`GpuMemoryError`) atau tab mati saat Develop (penanda
 *    di UI), jadi tile mengecil sampai muat di perangkat itu.
 */
export function exportTileMemoryBudget(maxBufferSize = Number.POSITIVE_INFINITY, scale = 1): number {
  const start = (imageMemoryBudget() < IMAGE_RGBA_BUDGET ? 384 : 640) * 1024 * 1024;
  const device = maxBufferSize * (TILE_BYTES_PER_PIXEL / LARGEST_BUFFER_BYTES_PER_PIXEL);
  return Math.floor(Math.min(start, device) * clampTileScale(scale));
}

/**
 * Working set GPU frame utuh untuk efek yang tidak bisa di-tile (lens blur,
 * difusi FFT). HP 640 MB: ekspor dengan efek ini diperkecil (~3 MP) alih-alih
 * membuat tab Safari dimatikan; desktop tidak dibatasi di sini.
 */
export function wholeFrameMemoryBudget(): number {
  return imageMemoryBudget() < IMAGE_RGBA_BUDGET ? 640 * 1024 * 1024 : Number.POSITIVE_INFINITY;
}

/** Limit GPU work and comparison frames to the same effective zoom size. */
export function previewPixelBudget(budget = imageMemoryBudget()): number {
  return budget < IMAGE_RGBA_BUDGET ? MOBILE_PREVIEW_PIXELS : 8_388_608;
}

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
  return mobile ? MOBILE_IMAGE_BUDGET : IMAGE_RGBA_BUDGET;
}

/** Preview history is useful, but should hold fewer full preview frames on phones. */
export function previewCacheBudgetBytes(budget = imageMemoryBudget()): number {
  return budget < IMAGE_RGBA_BUDGET ? budget / 32 : budget / 8;
}

export function assertImageBudget(width: number, height: number, bytesPerPixel = 16, budget = imageMemoryBudget()): void {
  const bytes = width * height * bytesPerPixel;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      !Number.isFinite(bytesPerPixel) || bytesPerPixel <= 0 ||
      !Number.isSafeInteger(bytes) || bytes > budget) {
    throw new RangeError(`Image ${width}×${height} exceeds the decoding memory limit. Open a smaller version of this photo.`);
  }
}
