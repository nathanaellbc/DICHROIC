/**
 * Bentuk `public/data/manifest.json` sebagaimana benar-benar dipancarkan
 * `tools/bake_web_assets.py` (Task 4) -- bukan bentuk yang diasumsikan draf
 * awal task-5-brief.md. Lihat `test/assets.test.ts` untuk kontrak penuh
 * (panjang tiap field, kesenjangan offset, dll); modul ini hanya
 * mendeklarasikan tipe TypeScript yang cocok dengannya.
 */

/** Referensi ke satu rentang float32 di dalam `stocks.f32` atau `static.f32`. */
export interface BlobRef {
  offsetFloats: number;
  lengthFloats: number;
  /**
   * Jumlah NaN sungguhan di dalam rentang ini -- celah pengukuran hulu
   * (mis. pada `channelDensity`/`baseDensity`), bukan nol. Hanya hadir kalau
   * > 0.
   */
  nullCount?: number;
}

/**
 * 23 field larik per-stock, persis field `ProfileCurveSet` dari
 * `$SPEKTRAFILM_OFX/src/SpektraProfileCurves.h`, dalam urutan emit
 * `tools/bake_web_assets.py::pack_stock`. Field lain milik stock (id, name,
 * type, wavelengthCount, dst.) adalah skalar/string dan hidup langsung di
 * `StockEntry`, bukan di sini.
 */
export const STOCK_FIELD_NAMES = [
  'wavelengths',
  'logSensitivity',
  'bandpassHanatos2025',
  'hanatos2026WindowParams',
  'referenceIlluminantSpectrum',
  'inputToReferenceXyz',
  'inputToSrgb',
  'mallettBasisIlluminant',
  'logExposure',
  'densityCurves',
  'channelDensity',
  'baseDensity',
  'densityCurveMinimum',
  'densityCurveLayers',
  'densityCurveLayerMaxima',
  'halationStrength',
  'halationFirstSigmaUm',
  'dirGammaSameLayerRgb',
  'dirGammaRToGb',
  'dirGammaGToRb',
  'dirGammaBToRg',
  'scanIlluminant',
  'scanToOutputRgb',
] as const satisfies readonly string[];

export type StockFieldName = (typeof STOCK_FIELD_NAMES)[number];

/**
 * 14 tabel global di `manifest.static`, backing store `static.f32`. (2 dari
 * 16 accessor `SpektraProfileCurves.h` yang lain -- `colorSpaces.labels` dan
 * konstanta LUT -- hidup di `manifest.colorSpaces`, bukan sebagai tabel
 * float; lihat `ColorSpaces` di bawah.)
 */
export const STATIC_TABLE_NAMES = [
  'outputGamutCompression',
  'inputMeterXyzMatrices',
  'colorTransferKinds',
  'colorTransferParams',
  'colorDecodeLuts',
  'colorEncodeLuts',
  'standardObserverCmfs',
  'thKg3Illuminant',
  'customEnlargerFilters',
  'neutralPrintFilters',
  'academyPrinterDensityResponsivities',
  'academyPrinterDensityNeutralOffsets',
  'academyPrinterDensityData',
  'academyPrinterDensityInfluxSpectrum',
] as const satisfies readonly string[];

export type StaticTableName = (typeof STATIC_TABLE_NAMES)[number];

/** Metadata dan referensi field larik satu stock film/kertas. */
export interface StockEntry {
  id: string;
  name: string;
  type: string;
  referenceIlluminant: string;
  viewingIlluminant: string;
  wavelengthCount: number;
  exposureCount: number;
  mallettRawMidgrayGreen: number;
  license: string;
  citation: string;
  datasource: string;
  /**
   * null hanya berlaku sah untuk `bandpassHanatos2025` pada stock kertas
   * (bandpass Hanatos 2025 tidak berlaku untuk kertas cetak) -- setiap field
   * lain selalu berupa `BlobRef` nyata untuk semua 28 stock.
   */
  fields: Record<StockFieldName, BlobRef | null>;
}

export interface HanatosDims {
  width: number;
  height: number;
  bands: number;
}

export interface ColorSpaces {
  count: number;
  transferLutSize: number;
  outputGamutCompressionStride: number;
  labels: string[];
  decodeLutMin: number;
  decodeLutMax: number;
  encodeLutMin: number;
  encodeLutMax: number;
}

export interface Counts {
  filmCount: number;
  paperCount: number;
  defaultFilmIndex: number;
  defaultPaperIndex: number;
  /**
   * false pada build ini: CSV SMPTE ST 2065-2 berlisensi dan tidak
   * diredistribusikan hulu (lihat `tools/README.md`, Task 1). Saat false,
   * ke-4 tabel `academyPrinterDensity*` di `manifest.static` bernilai nol
   * resmi hulu (fitur nonaktif) -- itu kondisi BERBEDA dari `nullCount` NaN
   * pada field stock, dan tidak boleh tertukar.
   */
  academyPrinterDensityEnabled: boolean;
}

export interface Manifest {
  hanatos: HanatosDims;
  colorSpaces: ColorSpaces;
  counts: Counts;
  stocks: StockEntry[];
  static: Record<StaticTableName, BlobRef>;
}

/** Kurva H&D siap pakai satu stock: log-exposure (n titik) + densitas 3-kanal (n*3, row-major RGB). */
export interface Stock {
  entry: StockEntry;
  logExposure: Float32Array;
  densityCurves: Float32Array;
}
