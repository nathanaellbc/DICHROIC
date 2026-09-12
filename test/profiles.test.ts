import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAssets, expandF16, STOCK_FIELD_NAMES, STATIC_TABLE_NAMES } from '../src/profiles/load';
import type {
  AssetBundle,
  ReadonlyFloat32Array,
  StockFieldName,
  StaticTableName,
} from '../src/profiles/load';

const DATA = join('public', 'data');

let bundle: AssetBundle;

beforeAll(async () => {
  bundle = await loadAssets(DATA);
});

/**
 * Blob mentah dibaca ulang lewat fs, terpisah sepenuhnya dari loader yang
 * diuji -- ini adalah oracle independen untuk tes "slice yang tepat" di
 * bawah. Kalau loader punya off-by-one di suatu offset, atau membaca satu
 * field dengan panjang field lain, perbandingan terhadap slice yang dihitung
 * di sini (dari offsetFloats/lengthFloats manifest secara langsung) akan
 * gagal.
 */
function readRawBlob(name: string): Float32Array {
  const buf = readFileSync(join(DATA, name));
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Kesetaraan yang sadar-NaN: Float32Array a dan b dianggap sama jika tiap
 * elemen sama persis, ATAU keduanya NaN pada indeks itu. `toEqual` bawaan
 * vitest atas TypedArray sudah menganggap NaN === NaN, tapi perbandingan
 * manual ini membuat kegagalan menunjuk ke indeks yang tepat.
 */
function expectSameFloats(got: ReadonlyFloat32Array, want: Float32Array, label: string): void {
  expect(got.length, label).toBe(want.length);
  // Bandingkan dengan loop biasa (tanpa `expect` per elemen -- itu terlalu
  // lambat untuk larik besar seperti colorDecodeLuts, 26*4096 elemen) dan
  // hanya panggil `expect` sekali, menunjuk ke indeks mismatch pertama, kalau
  // memang ada perbedaan.
  for (let i = 0; i < want.length; i += 1) {
    const g = got[i]!;
    const w = want[i]!;
    const same = Number.isNaN(w) ? Number.isNaN(g) : g === w;
    if (!same) {
      expect(g, `${label}[${i}]: dapat ${g}, seharusnya ${w}`).toBe(w);
    }
  }
}

describe('loadAssets', () => {
  it('memuat 28 stock dari manifest', () => {
    expect(bundle.manifest.stocks).toHaveLength(28);
  });

  it('stock(): kurva Portra 400 punya logExposure/densityCurves sepanjang exposureCount stock itu sendiri', () => {
    const entry = bundle.stockEntry('kodak_portra_400');
    const stock = bundle.stock('kodak_portra_400');
    expect(stock.logExposure).toHaveLength(entry.exposureCount);
    expect(stock.densityCurves).toHaveLength(entry.exposureCount * 3);
  });

  it('log exposure menaik monoton', () => {
    const { logExposure } = bundle.stock('kodak_portra_400');
    for (let i = 1; i < logExposure.length; i += 1) {
      expect(logExposure[i]!).toBeGreaterThan(logExposure[i - 1]!);
    }
  });

  it('melempar galat yang jelas untuk id stock yang tidak dikenal', () => {
    expect(() => bundle.stock('tidak_ada')).toThrow(/tidak dikenal|unknown/i);
    expect(() => bundle.stockEntry('tidak_ada')).toThrow(/tidak dikenal|unknown/i);
    expect(() => bundle.stockField('tidak_ada', 'wavelengths')).toThrow(/tidak dikenal|unknown/i);
  });

  it('melempar galat untuk nama field yang tidak dikenal, bukan mengembalikan larik kosong', () => {
    expect(() =>
      bundle.stockField('kodak_portra_400', 'bukanField' as StockFieldName),
    ).toThrow(/tidak dikenal|unknown/i);
  });

  it('melempar galat untuk nama tabel global yang tidak dikenal, bukan mengembalikan larik kosong', () => {
    expect(() => bundle.staticTable('bukanTabel' as StaticTableName)).toThrow(
      /tidak dikenal|unknown/i,
    );
  });

  describe('stockField: setiap slice cocok tepat dengan offset/panjang manifest, di seluruh 28 stock x 23 field', () => {
    const rawStocks = readRawBlob('stocks.f32');

    it('nilai identik dengan slice blob mentah dihitung langsung dari offsetFloats/lengthFloats; null hanya untuk bandpassHanatos2025 pada kertas', () => {
      for (const entry of bundle.manifest.stocks) {
        for (const field of STOCK_FIELD_NAMES) {
          // `field in entry.fields`, bukan `entry.fields[field] == null`:
          // `==` memperlakukan `undefined` (kunci benar-benar tidak ada --
          // tanda STOCK_FIELD_NAMES salah eja dan tidak cocok dengan manifest
          // nyata) sama dengan `null` (kunci ada, sengaja bernilai null --
          // satu-satunya kasus sah: bandpassHanatos2025 pada kertas). Kalau
          // ini gagal, itu nama field yang typo di types.ts, bukan data yang
          // sungguh absen.
          expect(field in entry.fields, `${entry.id} tidak punya kunci ${field} sama sekali`).toBe(
            true,
          );
          const ref = entry.fields[field];
          const got = bundle.stockField(entry.id, field);
          if (ref === null) {
            expect(got, `${entry.id}.${field}`).toBeNull();
            continue;
          }
          expect(got, `${entry.id}.${field}`).not.toBeNull();
          const want = rawStocks.subarray(ref.offsetFloats, ref.offsetFloats + ref.lengthFloats);
          expectSameFloats(got!, want, `${entry.id}.${field}`);
        }
      }
    });

    it('bandpassHanatos2025 hadir (non-null) untuk semua 20 film, null untuk semua 8 kertas', () => {
      const film = bundle.manifest.stocks.filter((s) => s.fields.bandpassHanatos2025 !== null);
      const paper = bundle.manifest.stocks.filter((s) => s.fields.bandpassHanatos2025 === null);
      expect(film).toHaveLength(20);
      expect(paper).toHaveLength(8);
      for (const s of film) {
        expect(bundle.stockField(s.id, 'bandpassHanatos2025'), s.id).not.toBeNull();
      }
      for (const s of paper) {
        expect(bundle.stockField(s.id, 'bandpassHanatos2025'), s.id).toBeNull();
      }
    });
  });

  describe('staticTable: seluruh 14 tabel global cocok tepat dengan manifest.static', () => {
    const rawStatic = readRawBlob('static.f32');

    it('nilai identik dengan slice blob mentah dihitung langsung dari offsetFloats/lengthFloats', () => {
      for (const name of STATIC_TABLE_NAMES) {
        const ref = bundle.manifest.static[name];
        const got = bundle.staticTable(name);
        const want = rawStatic.subarray(ref.offsetFloats, ref.offsetFloats + ref.lengthFloats);
        expectSameFloats(got, want, name);
      }
    });
  });

  describe('NaN celah pengukuran vs. nol fitur nonaktif -- dua kondisi "kosong" yang tidak boleh tertukar', () => {
    it('NaN pada channelDensity/baseDensity tidak disaring loader; jumlahnya cocok dengan nullCount manifest', () => {
      let totalNaN = 0;
      for (const entry of bundle.manifest.stocks) {
        for (const field of ['channelDensity', 'baseDensity'] as const) {
          const data = bundle.stockField(entry.id, field)!;
          let nanCount = 0;
          for (const v of data) if (Number.isNaN(v)) nanCount += 1;
          const expected = entry.fields[field]?.nullCount ?? 0;
          expect(nanCount, `${entry.id}.${field}`).toBe(expected);
          totalNaN += nanCount;
        }
      }
      // Kalau ini 0, tes di atas lolos secara kebetulan (tak ada NaN untuk
      // dibandingkan) -- pastikan skenario yang sebenarnya diuji nyata ada.
      expect(totalNaN).toBeGreaterThan(0);
    });

    it('tabel academyPrinterDensity* bernilai nol karena fitur nonaktif (bukan NaN diam-diam), sesuai counts.academyPrinterDensityEnabled', () => {
      expect(bundle.manifest.counts.academyPrinterDensityEnabled).toBe(false);
      const academyTables = [
        'academyPrinterDensityResponsivities',
        'academyPrinterDensityNeutralOffsets',
        'academyPrinterDensityData',
        'academyPrinterDensityInfluxSpectrum',
      ] as const;
      for (const name of academyTables) {
        const data = bundle.staticTable(name);
        expect(data.length, name).toBeGreaterThan(0);
        for (const v of data) {
          expect(Number.isNaN(v), `${name} punya NaN, seharusnya nol`).toBe(false);
          expect(v, name).toBe(0);
        }
      }
    });
  });

  describe('ekspansi Hanatos f16 -> f32', () => {
    it('panjang cocok width*height*bands dan seluruhnya finite', () => {
      const { width, height, bands } = bundle.manifest.hanatos;
      expect(bundle.hanatos).toBeInstanceOf(Float32Array);
      expect(bundle.hanatos).toHaveLength(width * height * bands);
      expect(bundle.hanatos.every(Number.isFinite)).toBe(true);
    });

    it('expandF16 menangani nol bertanda, subnormal, dan tak-hingga sesuai IEEE 754 binary16', () => {
      const src = new Uint16Array([
        0x0000, // +0
        0x8000, // -0
        0x0001, // subnormal terkecil: 2^-24
        0x03ff, // subnormal terbesar: 1023 * 2^-24
        0x3c00, // 1.0
        0x7c00, // +Inf
        0xfc00, // -Inf
        0x7c01, // NaN
      ]);
      const out = expandF16(src);
      expect(out[0]).toBe(0);
      expect(Object.is(out[1], -0)).toBe(true);
      expect(out[2]).toBe(Math.fround(2 ** -24));
      expect(out[3]).toBe(Math.fround(1023 * 2 ** -24));
      expect(out[4]).toBe(1);
      expect(out[5]).toBe(Infinity);
      expect(out[6]).toBe(-Infinity);
      expect(Number.isNaN(out[7]!)).toBe(true);
    });

    it('cocok bit-exact dengan np.float16(...).astype(np.float32) NumPy pada sampel nyata dari hanatos.f16, termasuk subnormal', () => {
      // Indeks dan nilai referensi dibangkitkan langsung dari .npy sumber lewat
      // D:/Projects/upstream/.venv-bake/Scripts/python.exe (lihat task-5-report.md
      // untuk perintah lengkap dan hasil perbandingan penuh atas ke-2.985.984
      // elemen: max abs diff 0.0). Dicatat statis di sini agar tes tidak
      // butuh Python saat dijalankan.
      const referenceSamples: Array<[number, number]> = [
        [1445930, 6.091594696044922e-5], // subnormal (raw 0x3fe)
        [1446011, 6.0498714447021484e-5], // subnormal (raw 0x3f7)
        [1446092, 6.0617923736572266e-5], // subnormal (raw 0x3f9)
        [1616058, 0.9697265625], // normal (raw 0x3bc2)
        [169803, 0.006175994873046875], // normal (raw 0x1e53)
        [1272185, 0.00249481201171875], // normal (raw 0x191c)
      ];
      for (const [idx, expected] of referenceSamples) {
        expect(bundle.hanatos[idx], `hanatos[${idx}]`).toBe(Math.fround(expected));
      }
    });
  });
});
