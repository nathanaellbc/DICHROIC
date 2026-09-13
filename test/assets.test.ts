import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA = join('public', 'data');
const manifest = JSON.parse(readFileSync(join(DATA, 'manifest.json'), 'utf8'));

/**
 * Daftar ini adalah stocks.FILMS dan stocks.PAPERS hulu
 * ($SPEKTRAFILM_OFX/tools/ofx_stock_lists.py, dari _LEGACY_FILM_ORDER dan
 * _LEGACY_PAPER_ORDER). Verifikasi terhadap berkas itu sebelum mengubah
 * daftar ini; kalau daftar hulu berbeda, hulu yang benar.
 */
const FILM = [
  'kodak_ektar_100', 'kodak_portra_160', 'kodak_portra_400',
  'kodak_portra_800', 'kodak_portra_800_push1', 'kodak_portra_800_push2',
  'kodak_gold_200', 'kodak_ultramax_400', 'kodak_vision3_50d',
  'kodak_vision3_250d', 'kodak_verita_200d', 'kodak_vision3_200t',
  'kodak_vision3_500t', 'fujifilm_pro_400h', 'fujifilm_c200',
  'fujifilm_xtra_400', 'kodak_ektachrome_100', 'kodak_kodachrome_64',
  'fujifilm_velvia_100', 'fujifilm_provia_100f',
];
const PAPER = [
  'kodak_endura_premier', 'kodak_ultra_endura', 'kodak_ektacolor_edge',
  'kodak_supra_endura', 'kodak_portra_endura',
  'fujifilm_crystal_archive_typeii', 'kodak_2383', 'kodak_2393',
];

type BlobRef = { offsetFloats: number; lengthFloats: number; nullCount?: number };

type StockEntry = {
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
  fields: Record<string, BlobRef | null>;
};

const COLOR_SPACE_COUNT = manifest.colorSpaces.count;

// Per-stock field -> expected lengthFloats, as an explicit function of that
// stock's own wavelengthCount/exposureCount and the global color-space
// count -- not hardcoded, so a real upstream shape change would fail this
// instead of silently mismatching. Mirrors $SPEKTRAFILM_OFX/src/SpektraProfileCurves.h's
// ProfileCurveSet field order.
function expectedLength(s: StockEntry, field: string): number {
  const wl = s.wavelengthCount;
  const exp = s.exposureCount;
  const cs9 = COLOR_SPACE_COUNT * 9;
  switch (field) {
    case 'wavelengths': return wl;
    case 'logSensitivity': return wl * 3;
    case 'bandpassHanatos2025': return wl * 3;
    case 'hanatos2026WindowParams': return 4;
    case 'referenceIlluminantSpectrum': return wl;
    case 'inputToReferenceXyz': return cs9;
    case 'inputToSrgb': return cs9;
    case 'mallettBasisIlluminant': return wl * 3;
    case 'logExposure': return exp;
    case 'densityCurves': return exp * 3;
    case 'channelDensity': return wl * 3;
    case 'baseDensity': return wl;
    case 'densityCurveMinimum': return 3;
    case 'densityCurveLayers': return exp * 3 * 3;
    case 'densityCurveLayerMaxima': return 9;
    case 'halationStrength': return 3;
    case 'halationFirstSigmaUm': return 3;
    case 'dirGammaSameLayerRgb': return 3;
    case 'dirGammaRToGb': return 2;
    case 'dirGammaGToRb': return 2;
    case 'dirGammaBToRg': return 2;
    case 'scanIlluminant': return wl;
    case 'scanToOutputRgb': return cs9;
    // Task 17 (PrintScan) -- 4 new fields, Python-only (no ProfileCurveSet
    // counterpart). Flat (3 channels x 3 layers) for the density-curve-model
    // trio; per-wavelength for the midgray reference spectrum.
    case 'densityCurvesModelCenters': return 9;
    case 'densityCurvesModelAmplitudes': return 9;
    case 'densityCurvesModelSigmas': return 9;
    case 'densitySpectralMidgray': return wl;
    default: throw new Error(`unknown field ${field}`);
  }
}

const ALL_PER_STOCK_FIELDS = [
  'wavelengths', 'logSensitivity', 'bandpassHanatos2025', 'hanatos2026WindowParams',
  'referenceIlluminantSpectrum', 'inputToReferenceXyz', 'inputToSrgb', 'mallettBasisIlluminant',
  'logExposure', 'densityCurves', 'channelDensity', 'baseDensity', 'densityCurveMinimum',
  'densityCurveLayers', 'densityCurveLayerMaxima', 'halationStrength', 'halationFirstSigmaUm',
  'dirGammaSameLayerRgb', 'dirGammaRToGb', 'dirGammaGToRb', 'dirGammaBToRg',
  'scanIlluminant', 'scanToOutputRgb',
  // Task 17 (PrintScan) -- Python-only, no ProfileCurveSet counterpart.
  'densityCurvesModelCenters', 'densityCurvesModelAmplitudes', 'densityCurvesModelSigmas',
  'densitySpectralMidgray',
];

// Fields short enough (<=4 floats) that a legitimate upstream default can be
// a constant or all-zero array (e.g. hanatos2026WindowParams is [0,0,0,0]
// for every paper stock -- verified directly against
// $SPEKTRAFILM_OFX/tools/generate_profile_curves.py's own fallback). The
// "not a constant array" gate below is scoped to exclude these so it stays
// a real signal instead of a false alarm on known-legitimate presets.
const ALLOWED_CONSTANT_FIELDS = new Set([
  'hanatos2026WindowParams', 'densityCurveMinimum', 'halationStrength',
  'halationFirstSigmaUm', 'dirGammaSameLayerRgb', 'dirGammaRToGb',
  'dirGammaGToRb', 'dirGammaBToRg',
  // kodak_2393's density_curves_layers genuinely saturates at 1.35 across
  // every layer/channel -- verified directly against upstream's own
  // _density_curve_layer_maxima(profile) output, not a bake bug.
  'densityCurveLayerMaxima',
]);

const stocksById = new Map<string, StockEntry>(
  manifest.stocks.map((s: StockEntry) => [s.id, s]),
);

let stocksBlobCache: Float32Array | null = null;
function stocksBlob(): Float32Array {
  if (!stocksBlobCache) {
    const buf = readFileSync(join(DATA, 'stocks.f32'));
    stocksBlobCache = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  return stocksBlobCache;
}

let staticBlobCache: Float32Array | null = null;
function staticBlob(): Float32Array {
  if (!staticBlobCache) {
    const buf = readFileSync(join(DATA, 'static.f32'));
    staticBlobCache = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  return staticBlobCache;
}

function slice(blob: Float32Array, ref: BlobRef): Float32Array {
  return blob.subarray(ref.offsetFloats, ref.offsetFloats + ref.lengthFloats);
}

/** log_exposure (n floats) followed by density_curves (n*3 floats, row-major). */
function readCurve(s: StockEntry) {
  const blob = stocksBlob();
  const logE = slice(blob, s.fields.logExposure!);
  const densitiesFlat = slice(blob, s.fields.densityCurves!);
  const n = logE.length;
  const densities: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    densities.push([densitiesFlat[i * 3]!, densitiesFlat[i * 3 + 1]!, densitiesFlat[i * 3 + 2]!]);
  }
  return { logE, densities };
}

describe('aset ter-bake: cakupan stock', () => {
  it('memuat tepat 20 film dan 8 kertas yang diharapkan', () => {
    expect(FILM).toHaveLength(20);
    expect(PAPER).toHaveLength(8);
    for (const id of [...FILM, ...PAPER]) {
      expect(stocksById.has(id), `stock hilang: ${id}`).toBe(true);
    }
    expect(manifest.stocks).toHaveLength(28);
    expect(manifest.counts).toEqual({
      filmCount: 20,
      paperCount: 8,
      defaultFilmIndex: 2,
      defaultPaperIndex: 4,
      academyPrinterDensityEnabled: false,
    });
  });

  it('LUT Hanatos berdimensi 192x192x81 dan f16', () => {
    expect(manifest.hanatos).toEqual({ width: 192, height: 192, bands: 81 });
    const bytes = readFileSync(join(DATA, 'hanatos.f16')).byteLength;
    expect(bytes).toBe(192 * 192 * 81 * 2);
  });

  it('tiap stock membawa metadata lisensi hulu', () => {
    for (const s of manifest.stocks as StockEntry[]) {
      expect(s.license, s.id).toBeTruthy();
      expect(s.citation, s.id).toBeTruthy();
    }
  });
});

describe('aset ter-bake: 31 field per stock (27 ProfileCurveSet + 4 Task 17 Python-only)', () => {
  it('tiap stock membawa seluruh 26 field larik (dari 31 total; 5 sisanya adalah skalar/string)', () => {
    // stock, name, type, referenceIlluminant + wavelengthCount/exposureCount
    // (5 skalar/string) hidup langsung di manifest, bukan di blob -- 26 field
    // sisanya adalah larik float dan harus muncul di s.fields (22 dari
    // ProfileCurveSet + 4 Task 17: densityCurvesModel{Centers,Amplitudes,
    // Sigmas}, densitySpectralMidgray).
    for (const s of manifest.stocks as StockEntry[]) {
      for (const field of ALL_PER_STOCK_FIELDS) {
        expect(field in s.fields, `${s.id} hilang field ${field}`).toBe(true);
      }
    }
  });

  it('bandpassHanatos2025 hadir untuk semua film, null untuk semua kertas', () => {
    for (const id of FILM) {
      expect(stocksById.get(id)!.fields.bandpassHanatos2025, id).not.toBeNull();
    }
    for (const id of PAPER) {
      expect(stocksById.get(id)!.fields.bandpassHanatos2025, id).toBeNull();
    }
  });

  it('densitySpectralMidgray (Task 17) hadir untuk semua film, null untuk semua kertas', () => {
    for (const id of FILM) {
      expect(stocksById.get(id)!.fields.densitySpectralMidgray, id).not.toBeNull();
    }
    for (const id of PAPER) {
      expect(stocksById.get(id)!.fields.densitySpectralMidgray, id).toBeNull();
    }
  });

  it('densityCurvesModel{Centers,Amplitudes,Sigmas} (Task 17) hadir untuk seluruh 28 stock', () => {
    // Diperiksa langsung terhadap JSON profil Python untuk seluruh 28 stock
    // (scratchpad probe, task-17-report.md) -- tidak ada yang hilang, tapi
    // gerbang ini membuktikannya ulang di sini, terhadap manifest nyata,
    // bukan cuma dipercaya dari catatan sesi lalu.
    for (const s of manifest.stocks as StockEntry[]) {
      expect(s.fields.densityCurvesModelCenters, s.id).not.toBeNull();
      expect(s.fields.densityCurvesModelAmplitudes, s.id).not.toBeNull();
      expect(s.fields.densityCurvesModelSigmas, s.id).not.toBeNull();
    }
  });

  it('panjang tiap field sama dengan yang diturunkan dari wavelengthCount/exposureCount stock itu sendiri', () => {
    for (const s of manifest.stocks as StockEntry[]) {
      for (const field of ALL_PER_STOCK_FIELDS) {
        const ref = s.fields[field];
        if (ref == null) continue; // bandpassHanatos2025 pada kertas
        expect(ref!.lengthFloats, `${s.id}.${field}`).toBe(expectedLength(s, field));
      }
    }
  });

  it('nullCount pada channelDensity/baseDensity cocok dengan NaN sungguhan di blob, dan tidak ada NaN tak tercatat di field lain', () => {
    const blob = stocksBlob();
    for (const s of manifest.stocks as StockEntry[]) {
      for (const field of ALL_PER_STOCK_FIELDS) {
        const ref = s.fields[field];
        if (ref == null) continue;
        const data = slice(blob, ref);
        let nanCount = 0;
        for (const v of data) if (Number.isNaN(v)) nanCount++;
        expect(nanCount, `${s.id}.${field} nullCount`).toBe(ref.nullCount ?? 0);
      }
    }
  });

  it('tidak ada larik non-trivial yang seluruhnya konstan (menunjukkan offset salah atau data belum terisi)', () => {
    const blob = stocksBlob();
    for (const s of manifest.stocks as StockEntry[]) {
      for (const field of ALL_PER_STOCK_FIELDS) {
        if (ALLOWED_CONSTANT_FIELDS.has(field)) continue;
        const ref = s.fields[field];
        if (ref == null) continue;
        const data = slice(blob, ref);
        const finite = Array.from(data).filter((v) => Number.isFinite(v));
        if (finite.length < 2) continue;
        const allEqual = finite.every((v) => v === finite[0]);
        expect(allEqual, `${s.id}.${field} seluruhnya konstan (${finite[0]})`).toBe(false);
      }
    }
  });

  it('inputToSrgb identik dan dibagi (offset sama) di seluruh 28 stock', () => {
    const first = (manifest.stocks[0] as StockEntry).fields.inputToSrgb!;
    for (const s of manifest.stocks as StockEntry[]) {
      expect(s.fields.inputToSrgb, s.id).toEqual(first);
    }
  });
});

describe('aset ter-bake: 16 tabel global (SpektraProfileCurves.h)', () => {
  const GLOBAL_TABLES = [
    'outputGamutCompression', 'inputMeterXyzMatrices', 'colorTransferKinds', 'colorTransferParams',
    'colorDecodeLuts', 'colorEncodeLuts', 'standardObserverCmfs', 'thKg3Illuminant',
    'customEnlargerFilters', 'neutralPrintFilters', 'academyPrinterDensityResponsivities',
    'academyPrinterDensityNeutralOffsets', 'academyPrinterDensityData', 'academyPrinterDensityInfluxSpectrum',
  ];

  it('seluruh 14 tabel float hadir di manifest.static (2 sisanya, label & konstanta, hidup di manifest.colorSpaces)', () => {
    for (const table of GLOBAL_TABLES) {
      expect(table in manifest.static, `tabel hilang: ${table}`).toBe(true);
    }
  });

  it('colorSpaces.labels punya tepat 26 label, dan konstanta cocok dengan data', () => {
    expect(manifest.colorSpaces.labels).toHaveLength(26);
    expect(manifest.colorSpaces.count).toBe(26);
    expect(manifest.colorSpaces.transferLutSize).toBe(4096);
    expect(manifest.colorSpaces.outputGamutCompressionStride).toBe(18);
  });

  it('colorDecodeLuts dan colorEncodeLuts masing-masing 26 * 4096 float', () => {
    expect(manifest.static.colorDecodeLuts.lengthFloats).toBe(26 * 4096);
    expect(manifest.static.colorEncodeLuts.lengthFloats).toBe(26 * 4096);
  });

  it('tabel academyPrinterDensity* bernilai nol (fitur nonaktif, sesuai academyPrinterDensityEnabled), bukan NaN diam-diam', () => {
    // File CSV SMPTE ST 2065-2 berlisensi dan tidak diredistribusikan hulu
    // (lihat tools/README.md, Task 1), jadi academy_printer_density_available()
    // hulu bernilai False di checkout ini -- ke-4 tabel akademi jatuh ke
    // fallback nol resmi hulu sendiri (_zero_spectral_rows dkk.), bukan data
    // yang hilang. Ini beda dari kasus channelDensity/baseDensity (NaN
    // eksplisit) -- diperiksa terpisah agar dua alasan "kosong" ini tidak
    // pernah tertukar diam-diam.
    expect(manifest.counts.academyPrinterDensityEnabled).toBe(false);
    const blob = staticBlob();
    for (const table of [
      'academyPrinterDensityResponsivities', 'academyPrinterDensityNeutralOffsets',
      'academyPrinterDensityData', 'academyPrinterDensityInfluxSpectrum',
    ]) {
      const data = slice(blob, manifest.static[table]);
      expect(data.every((v) => v === 0), table).toBe(true);
    }
  });

  it('tabel global besar tidak seluruhnya konstan dan tidak mengandung NaN/Inf tak terduga', () => {
    const blob = staticBlob();
    const skipConstantCheck = new Set([
      'academyPrinterDensityResponsivities', 'academyPrinterDensityNeutralOffsets',
      'academyPrinterDensityData', 'academyPrinterDensityInfluxSpectrum',
    ]);
    for (const table of GLOBAL_TABLES) {
      const data = slice(blob, manifest.static[table]);
      for (const v of data) {
        expect(Number.isFinite(v), `${table} punya nilai non-finite`).toBe(true);
      }
      if (skipConstantCheck.has(table)) continue;
      const allEqual = data.every((v) => v === data[0]);
      expect(allEqual, `${table} seluruhnya konstan`).toBe(false);
    }
  });
});

describe('aset ter-bake: offset bersambung tanpa celah', () => {
  it('stocks.f32: seluruh region (termasuk inputToSrgb yang dibagi) menutupi blob tanpa celah maupun overlap liar', () => {
    const regions = new Map<string, { offset: number; length: number; labels: string[] }>();
    for (const s of manifest.stocks as StockEntry[]) {
      for (const field of ALL_PER_STOCK_FIELDS) {
        const ref = s.fields[field];
        if (ref == null) continue;
        const key = `${ref.offsetFloats}:${ref.lengthFloats}`;
        const label = `${s.id}.${field}`;
        const existing = regions.get(key);
        if (existing) existing.labels.push(label);
        else regions.set(key, { offset: ref.offsetFloats, length: ref.lengthFloats, labels: [label] });
      }
    }
    // Region apa pun yang dirujuk lebih dari sekali harus HANYA berasal dari
    // field inputToSrgb (satu-satunya tabel yang sengaja dibagi 28 stock --
    // lihat tes di atas). Kalau region lain ikut bertumpuk, itu tanda offset
    // salah tulis, bukan berbagi yang disengaja.
    for (const region of regions.values()) {
      if (region.labels.length > 1) {
        for (const label of region.labels) {
          expect(label.endsWith('.inputToSrgb'), `region dibagi tak terduga: ${label}`).toBe(true);
        }
      }
    }
    const tiles = Array.from(regions.values()).sort((a, b) => a.offset - b.offset);
    let cursor = 0;
    for (const tile of tiles) {
      expect(tile.offset, `celah pada offset ${cursor}`).toBe(cursor);
      cursor += tile.length;
    }
    const bytes = readFileSync(join(DATA, 'stocks.f32')).byteLength;
    expect(bytes).toBe(cursor * 4);
  });

  it('static.f32: seluruh 14 tabel menutupi blob tanpa celah, tanpa berbagi', () => {
    const GLOBAL_TABLES = [
      'outputGamutCompression', 'inputMeterXyzMatrices', 'colorTransferKinds', 'colorTransferParams',
      'colorDecodeLuts', 'colorEncodeLuts', 'standardObserverCmfs', 'thKg3Illuminant',
      'customEnlargerFilters', 'neutralPrintFilters', 'academyPrinterDensityResponsivities',
      'academyPrinterDensityNeutralOffsets', 'academyPrinterDensityData', 'academyPrinterDensityInfluxSpectrum',
    ];
    const tiles = GLOBAL_TABLES
      .map((table) => ({ table, ...(manifest.static[table] as BlobRef) }))
      .sort((a, b) => a.offsetFloats - b.offsetFloats);
    let cursor = 0;
    for (const tile of tiles) {
      expect(tile.offsetFloats, `celah sebelum ${tile.table}`).toBe(cursor);
      cursor += tile.lengthFloats;
    }
    const bytes = readFileSync(join(DATA, 'static.f32')).byteLength;
    expect(bytes).toBe(cursor * 4);
  });
});

describe('aset ter-bake: fisika kurva densitas', () => {
  it('kurva densitas naik terhadap log-exposure untuk film negatif, turun untuk film positif (reversal)', () => {
    // Fisika H&D: pada film negatif, densitas naik seiring eksposur
    // bertambah. Pada film reversal/positif (mis. Ektachrome, Velvia),
    // proses pembalikan berarti densitas justru TURUN seiring eksposur
    // bertambah -- ini bukan noise, ini terverifikasi langsung dari
    // Resources/data/profiles/kodak_ektachrome_100.json hulu (77% dari
    // langkah berdekatan menurun, tren keseluruhan turun tajam).
    // Kurva mentah punya wiggle lokal (noise sensitometrik), jadi
    // pemeriksaan ini membandingkan rata-rata kuartil pertama vs kuartil
    // terakhir sepanjang log_exposure, bukan monotonisitas titik-demi-titik.
    for (const s of manifest.stocks as StockEntry[]) {
      const { densities } = readCurve(s);
      const n = densities.length;
      const quarter = Math.max(1, Math.floor(n / 4));
      const mean = (rows: [number, number, number][]) =>
        rows.reduce((sum, row) => sum + row[0] + row[1] + row[2], 0) / (rows.length * 3);
      const lowMean = mean(densities.slice(0, quarter));
      const highMean = mean(densities.slice(n - quarter));

      if (s.type === 'positive') {
        expect(highMean, s.id).toBeLessThan(lowMean);
      } else {
        expect(highMean, s.id).toBeGreaterThan(lowMean);
      }
    }
  });

  it('Dmax rata-rata kertas cetak melebihi Dmax rata-rata film negatif kamera, sesuai fisika', () => {
    // Kertas/print stock menumpuk lebih banyak densitas dye karena ia
    // adalah citra akhir yang dilihat; film negatif kamera menyimpan
    // jauh lebih sedikit karena hanya perantara ke tahap cetak. Diverifikasi
    // terhadap data hulu langsung: film negatif kamera (FILM, type==negative)
    // rata-rata Dmax ~2.17, kertas cetak (PAPER) rata-rata ~2.52, dengan
    // stok cetak film bioskop (kodak_2383/2393) mencapai 3.36/4.05 -- jauh
    // di atas film kamera mana pun. Dibandingkan sebagai rata-rata
    // kelompok, bukan per pasangan, karena film reversal (slide) individual
    // bisa melebihi Dmax kertas tertentu tanpa melanggar tren kelompok.
    const dmaxOf = (id: string) => {
      const s = stocksById.get(id)!;
      const { densities } = readCurve(s);
      let dmax = -Infinity;
      for (const row of densities) {
        for (const v of row) dmax = Math.max(dmax, v);
      }
      return dmax;
    };

    const cameraNegativeFilm = FILM.filter((id) => stocksById.get(id)!.type === 'negative');
    const avg = (ids: string[]) => ids.reduce((sum, id) => sum + dmaxOf(id), 0) / ids.length;

    expect(avg(PAPER)).toBeGreaterThan(avg(cameraNegativeFilm));
  });
});

describe('aset ter-bake: static.f32 (kompresi gamut keluaran)', () => {
  it('cocok dengan manifest dan tidak seluruhnya nol', () => {
    const entry = manifest.static.outputGamutCompression;
    const bytes = readFileSync(join(DATA, 'static.f32')).byteLength;
    expect(bytes).toBeGreaterThanOrEqual(entry.lengthFloats * 4);
    const floats = slice(staticBlob(), entry);
    expect(floats.some((v) => v !== 0)).toBe(true);
  });
});
