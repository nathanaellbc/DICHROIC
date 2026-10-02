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

/** Emulsion's export lattice and memory policy, adapted to our buffer graph. */
export const EXPORT_TILE_LATTICE = 128;
export function planExportTiles(
  width: number, height: number, maxBufferBytes: number, overlap: number,
  memoryBudget: number, bytesPerPixel = 160,
): TileSpec[] {
  const lattice = EXPORT_TILE_LATTICE;
  const side = Math.min(Math.floor(Math.sqrt(maxBufferBytes / BYTES_PER_PIXEL)),
    Math.floor(Math.sqrt(memoryBudget / bytesPerPixel)));
  const apron = Math.ceil(overlap / lattice) * lattice;
  // Like Emulsion, spatial context takes priority over the soft RAM budget.
  // Storage binding limits remain hard limits.
  let core = Math.max(256, Math.floor((side - 2 * apron) / lattice) * lattice);
  const bindingSide = Math.floor(Math.sqrt(maxBufferBytes / BYTES_PER_PIXEL));
  while (core > lattice && Math.min(width, core + 2 * apron) * Math.min(height, core + 2 * apron) > bindingSide ** 2) core -= lattice;
  if (Math.min(width, core + 2 * apron) * Math.min(height, core + 2 * apron) * BYTES_PER_PIXEL > maxBufferBytes) {
    throw new RangeError('Spatial blur margins exceed the GPU tile budget. Reduce resolution or use a larger film format.');
  }
  if (width <= side && height <= side) return [{
    tileOriginX: 0, tileOriginY: 0, activeOriginX: 0, activeOriginY: 0,
    activeWidth: width, activeHeight: height, tileWidth: width, tileHeight: height,
  }];
  const tiles: TileSpec[] = [];
  for (let y = 0; y < height; y += core) for (let x = 0; x < width; x += core) {
    const w = Math.min(core, width - x); const h = Math.min(core, height - y);
    const ox = Math.max(0, x - apron); const oy = Math.max(0, y - apron);
    tiles.push({ tileOriginX: ox, tileOriginY: oy, activeOriginX: x, activeOriginY: y,
      activeWidth: w, activeHeight: h,
      tileWidth: Math.min(width, Math.ceil((x + w + apron) / lattice) * lattice) - ox,
      tileHeight: Math.min(height, Math.ceil((y + h + apron) / lattice) * lattice) - oy });
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
