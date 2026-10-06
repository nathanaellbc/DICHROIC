/**
 * Task 19: perencana render ter-tile dengan apron.
 *
 * Port `estimateVulkanTileOverlap`
 * ($SPEKTRAFILM_OFX/src/SpektraVulkanRenderer.cpp:1183-1236) --
 * SATU-SATUNYA sumber hulu yang relevan di sini. Python (oracle utama
 * Global Constraints) bekerja full-frame dan tidak punya konsep tiling
 * sama sekali, jadi aturan "Python menang" TIDAK berlaku pada modul ini --
 * tidak ada dua implementasi hulu yang bisa berselisih, hanya OFX.
 *
 * Konstanta `kVulkanSpatialEffectRadiusPx=256`/`kVulkanGrainSpatialRadiusPx=64`
 * dibaca langsung dari source hulu di atas (bukan ditebak dari nama) dan
 * dipakai apa adanya di bawah.
 */

/** Satu tile: posisinya di ruang gambar penuh, plus sub-rektangel aktif di dalam buffernya sendiri. */
export interface TileSpec {
  /** Origin buffer tile ini pada ruang koordinat gambar PENUH (termasuk apron). */
  tileOriginX: number;
  tileOriginY: number;
  /**
   * Origin sub-rektangel AKTIF (tanpa apron), dalam ruang koordinat gambar
   * PENUH -- BUKAN lokal ke buffer tile. Menerjemahkan ke `CoreParams.
   * activeOriginX/Y` (yang LOKAL ke buffer) berarti mengurangi `tileOriginX/Y`
   * dari nilai ini -- lih. `graph.ts` untuk konversi tersebut.
   */
  activeOriginX: number;
  activeOriginY: number;
  activeWidth: number;
  activeHeight: number;
  /** Dimensi buffer tile ini, termasuk apron (diklip ke batas gambar). */
  tileWidth: number;
  tileHeight: number;
}

/**
 * Efek spasial mana yang aktif untuk render yang sedang direncanakan.
 * `dirCouplersAmount` numerik (bukan boolean) karena radius kernel DIR
 * bergantung amount/diffusion_size -- lih. dokumentasi `estimateTileOverlap`
 * di bawah.
 */
export interface SpatialEffectFlags {
  halationEnabled: boolean;
  grainEnabled: boolean;
  cameraDiffusionEnabled: boolean;
  printDiffusionEnabled: boolean;
  dirCouplersAmount: number;
  scannerUnsharpEnabled: boolean;
}

/**
 * `kVulkanSpatialEffectRadiusPx` hulu -- radius apron seragam yang OFX
 * pakai untuk SETIAP efek spasial "besar" (diffusion kamera/print, halation,
 * DIR couplers, unsharp scanner). Jauh lebih besar dari radius kernel
 * sungguhan pada gambar uji kecil (0-2px, lih. dir.wgsl/halation.wgsl) --
 * disengaja hulu, bukan longgar tanpa alasan: OFX dirancang untuk gambar
 * produksi berresolusi penuh, bukan fixture 32-64px port ini.
 *
 * Task 19b: diekspor (bukan hanya modul-lokal) supaya stage factory
 * (`engine/stages/*.ts`) bisa mendeklarasikan `Stage.spatialRadiusPx`
 * masing-masing dari SUMBER YANG SAMA -- lih. `graph.ts::runSingleBuffer`,
 * yang menjumlahkan `spatialRadiusPx` tiap tahap untuk `remainingSpatialRadius`
 * dan HARUS menjumlahkan persis nilai yang `estimateTileOverlap` di bawah
 * pakai, atau apron buffer (dari `planTiles`) akan lebih sempit dari radius
 * yang diminta tahap-tahap yang sebenarnya berjalan.
 */
export const SPATIAL_EFFECT_RADIUS_PX = 256;

/** `kVulkanGrainSpatialRadiusPx` hulu -- radius apron grain, lebih kecil dari efek spasial lain. */
export const GRAIN_SPATIAL_RADIUS_PX = 64;

/**
 * Port `estimateVulkanTileOverlap` (`SpektraVulkanRenderer.cpp:1190-1235`).
 * Hulu memeriksa banyak sub-kondisi per efek (strength>0, scale>0, dst.) --
 * disederhanakan di sini menjadi satu boolean/angka per efek (`SpatialEffectFlags`)
 * karena pemanggil (RenderGraph/host) sudah tahu apakah kernel efek itu
 * benar-benar akan didispatch, persis makna field-field hulu itu digabung.
 * `dirCouplersAmount > 0` meniru kondisi hulu
 * `dirCouplersAmount > 0.0f && (dirCouplersDiffusionUm > 0.0f || ...)`
 * -- pemanggil bertanggung jawab menyalurkan 0 ketika kernel DIR memang
 * identitas (radius-0), bukan sekadar "amount" numerik apa pun.
 */
export function estimateTileOverlap(flags: SpatialEffectFlags): number {
  let overlap = 0;
  if (flags.cameraDiffusionEnabled) overlap += SPATIAL_EFFECT_RADIUS_PX;
  if (flags.halationEnabled) overlap += SPATIAL_EFFECT_RADIUS_PX;
  if (flags.dirCouplersAmount > 0) overlap += SPATIAL_EFFECT_RADIUS_PX;
  if (flags.grainEnabled) overlap += GRAIN_SPATIAL_RADIUS_PX;
  if (flags.printDiffusionEnabled) overlap += SPATIAL_EFFECT_RADIUS_PX;
  if (flags.scannerUnsharpEnabled) overlap += SPATIAL_EFFECT_RADIUS_PX;
  return overlap;
}

/** RGBA f32 -- sama seperti asumsi ukuran piksel di seluruh `RenderGraph`/`graph.ts`. */
const BYTES_PER_PIXEL = 4 * Float32Array.BYTES_PER_ELEMENT;

/** Sisi inti tile ekspor dibulatkan ke kelipatan ini (rapi, tanpa syarat kebenaran). */
export const EXPORT_TILE_LATTICE = 64;
/**
 * Byte GPU per piksel tile rantai produksi penuh, TERUKUR (lavapipe, grain
 * menyala): ping + pong + readback 48 B, lima slot scratch 144 B.
 */
export const EXPORT_GPU_BYTES_PER_PIXEL = 192;
/** Inti tile minimum: di bawah ini kerja ulang apron membengkak tanpa batas. */
export const EXPORT_MIN_CORE = 256;

/**
 * Tile ekspor: inti persegi selebar mungkin sehingga (inti + 2 apron)^2 x
 * `bytesPerPixel` <= `memoryBudget` dan buffer RGBA f32-nya <= batas binding.
 * Apron dipakai EKSAK (tanpa dibulatkan); tile di tepi gambar terpotong.
 * Bila bahkan inti minimum tidak muat, anggaran lunak dilampaui (konteks
 * spasial lebih penting), batas binding tetap keras.
 */
export function planExportTiles(
  width: number, height: number, maxBufferBytes: number, overlap: number,
  memoryBudget: number, bytesPerPixel = EXPORT_GPU_BYTES_PER_PIXEL,
): TileSpec[] {
  const lattice = EXPORT_TILE_LATTICE;
  const apron = Math.max(0, Math.ceil(overlap));
  const bindingSide = Math.floor(Math.sqrt(maxBufferBytes / BYTES_PER_PIXEL));
  const side = Math.min(bindingSide, Math.floor(Math.sqrt(memoryBudget / bytesPerPixel)));
  if (width * height * bytesPerPixel <= memoryBudget && width * height * BYTES_PER_PIXEL <= maxBufferBytes) return [{
    tileOriginX: 0, tileOriginY: 0, activeOriginX: 0, activeOriginY: 0,
    activeWidth: width, activeHeight: height, tileWidth: width, tileHeight: height,
  }];
  let core = Math.max(EXPORT_MIN_CORE, Math.floor((side - 2 * apron) / lattice) * lattice);
  const tileArea = (c: number) => Math.min(width, c + 2 * apron) * Math.min(height, c + 2 * apron);
  while (core > lattice && tileArea(core) > bindingSide ** 2) core -= lattice;
  if (tileArea(core) * BYTES_PER_PIXEL > maxBufferBytes) {
    throw new RangeError('Spatial blur margins exceed the GPU tile budget. Reduce resolution or use a larger film format.');
  }
  // Bagi rata (bukan langkah `core` literal): tile terakhir tidak jomplang kecil.
  const cols = Math.ceil(width / core);
  const rows = Math.ceil(height / core);
  const tiles: TileSpec[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = Math.floor((i * width) / cols); const x1 = Math.floor(((i + 1) * width) / cols);
    const y = Math.floor((j * height) / rows); const y1 = Math.floor(((j + 1) * height) / rows);
    const ox = Math.max(0, x - apron); const oy = Math.max(0, y - apron);
    tiles.push({ tileOriginX: ox, tileOriginY: oy, activeOriginX: x, activeOriginY: y,
      activeWidth: x1 - x, activeHeight: y1 - y,
      tileWidth: Math.min(width, x1 + apron) - ox, tileHeight: Math.min(height, y1 + apron) - oy });
  }
  return tiles;
}

/**
 * Bagi gambar `width`x`height` menjadi grid tile, masing-masing dengan
 * sub-rektangel AKTIF yang bersama-sama menutupi gambar penuh TANPA celah
 * dan TANPA tumpang tindih (dua invarian yang `tiling.test.ts` buktikan
 * langsung), dan buffer (aktif + apron `overlap` di setiap sisi, diklip ke
 * batas gambar) yang muat dalam `maxBytes`.
 *
 * Strategi: cari sisi tile aktif persegi terbesar yang buffernya (aktif +
 * 2*overlap per sumbu) muat dalam `maxBytes`, lalu bagi `width`/`height`
 * rata ke jumlah tile bulat-ke-atas pada sisi itu (bukan memakai sisi itu
 * literal sebagai step) -- ini menjaga TIAP tile pada satu baris/kolom
 * berukuran sama (±1px dari pembulatan), bukan tile terakhir yang jomplang
 * kecil, sambil tetap menghormati anggaran `maxBytes` (ukuran tile hasil
 * SELALU <= ukuran yang anggaran izinkan, karena pembagian rata-ke-atas
 * hanya mengecilkan tile aktif, tidak pernah membesarkannya).
 */
export function planTiles(
  width: number,
  height: number,
  maxBytes: number,
  overlap: number,
  forceTiling = false,
): TileSpec[] {
  if (width <= 0 || height <= 0) return [];
  if (!forceTiling && width * height * BYTES_PER_PIXEL <= maxBytes) return [{
    tileOriginX: 0, tileOriginY: 0, activeOriginX: 0, activeOriginY: 0,
    activeWidth: width, activeHeight: height, tileWidth: width, tileHeight: height,
  }];

  const maxPixels = Math.max(1, Math.floor(maxBytes / BYTES_PER_PIXEL));
  const budgetSide = Math.max(1, Math.floor(Math.sqrt(maxPixels)));
  const activeSide = Math.max(1, budgetSide - 2 * overlap);
  if (!forceTiling && Math.min(width, 2 * overlap + 1) * Math.min(height, 2 * overlap + 1) > maxPixels) {
    throw new RangeError('Spatial blur margins exceed the GPU tile budget. Reduce resolution or use a larger film format.');
  }

  const tilesX = Math.max(1, Math.ceil(width / activeSide));
  const tilesY = Math.max(1, Math.ceil(height / activeSide));
  const activeTileWidth = Math.ceil(width / tilesX);
  const activeTileHeight = Math.ceil(height / tilesY);

  const tiles: TileSpec[] = [];
  for (let ty = 0; ty < tilesY; ty += 1) {
    const activeOriginY = ty * activeTileHeight;
    const activeHeight = Math.min(activeTileHeight, height - activeOriginY);
    if (activeHeight <= 0) continue;

    for (let tx = 0; tx < tilesX; tx += 1) {
      const activeOriginX = tx * activeTileWidth;
      const activeWidth = Math.min(activeTileWidth, width - activeOriginX);
      if (activeWidth <= 0) continue;

      const tileOriginX = Math.max(0, activeOriginX - overlap);
      const tileOriginY = Math.max(0, activeOriginY - overlap);
      const tileEndX = Math.min(width, activeOriginX + activeWidth + overlap);
      const tileEndY = Math.min(height, activeOriginY + activeHeight + overlap);

      tiles.push({
        tileOriginX,
        tileOriginY,
        activeOriginX,
        activeOriginY,
        activeWidth,
        activeHeight,
        tileWidth: tileEndX - tileOriginX,
        tileHeight: tileEndY - tileOriginY,
      });
    }
  }
  return tiles;
}
