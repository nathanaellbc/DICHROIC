/**
 * Bentuk `public/data/manifest.json` sebagaimana benar-benar dipancarkan
 * `tools/bake_web_assets.py` (Task 4) -- bukan bentuk yang diasumsikan draf
 * awal task-5-brief.md. Lihat `test/assets.test.ts` untuk kontrak penuh
 * (panjang tiap field, kesenjangan offset, dll); modul ini hanya
 * mendeklarasikan tipe TypeScript yang cocok dengannya.
 */

/**
 * Float32Array yang tidak bisa ditulisi lewat referensi bertipe ini.
 *
 * `load.ts` mengembalikan *view* (`subarray`), bukan salinan, ke atas satu
 * buffer bersama per blob (`stocks.f32`/`static.f32`/`hanatos.f16`
 * terekspansi) -- delapan tahap GPU-arena (Task 11-18) semuanya cuma perlu
 * membaca darinya, jadi menyalin di setiap panggilan akan sia-sia. Tapi
 * `Float32Array.subarray()` biasa tetap bisa ditulisi: `view[0] = 1` akan
 * menimpa field/tabel LAIN yang kebetulan berbagi buffer itu, untuk setiap
 * stock dan setiap konsumen lain, tanpa galat di mana pun -- gejalanya
 * muncul di tahap yang sama sekali tidak menyentuh data itu.
 * `Object.freeze` tidak menolong (properti berindeks-integer pada typed
 * array dikecualikan darinya), jadi larangannya ditegakkan di level tipe:
 * index signature bawaan di-override jadi `readonly` dan method mutasi
 * (`set`, `fill`, `sort`, `copyWithin`, `reverse`) dibuang, sehingga
 * `view[i] = x` atau `view.fill(0)` adalah galat kompilasi di tempat
 * pemanggilan, bukan korupsi data senyap saat runtime. Menugaskan
 * `Float32Array` mutable ke variabel bertipe ini tetap sah (sama seperti
 * `T[]` ke `readonly T[]`) -- yang dicegah hanya menulis LEWAT referensi
 * yang bertipe hanya-baca ini, bukan keberadaan pemilik mutable di tempat
 * lain (di sini, tidak ada -- `load.ts` tidak pernah menyimpan referensi
 * mutable ke slice yang sudah dibagikan keluar).
 */
type TypedArrayMutableMethods = 'set' | 'fill' | 'sort' | 'copyWithin' | 'reverse';
export interface ReadonlyFloat32Array extends Omit<Float32Array, TypedArrayMutableMethods> {
  readonly [index: number]: number;
}

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
  logExposure: ReadonlyFloat32Array;
  densityCurves: ReadonlyFloat32Array;
}
