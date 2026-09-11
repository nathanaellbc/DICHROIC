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

type StockEntry = {
  id: string;
  name: string;
  type: string;
  offsetFloats: number;
  lengthFloats: number;
  curvePoints: number;
  license: string;
  citation: string;
  datasource: string;
};

const stocksById = new Map<string, StockEntry>(
  manifest.stocks.map((s: StockEntry) => [s.id, s]),
);

function readStocksBlob(): Float32Array {
  const buf = readFileSync(join(DATA, 'stocks.f32'));
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** log_exposure (n floats) followed by density_curves (n*3 floats, row-major RGB/CMY triples). */
function readCurve(blob: Float32Array, s: StockEntry) {
  const n = s.curvePoints;
  const logE = blob.subarray(s.offsetFloats, s.offsetFloats + n);
  const densities: [number, number, number][] = [];
  const base = s.offsetFloats + n;
  for (let i = 0; i < n; i++) {
    densities.push([blob[base + i * 3], blob[base + i * 3 + 1], blob[base + i * 3 + 2]]);
  }
  return { logE, densities };
}

describe('aset ter-bake', () => {
  it('memuat tepat 20 film dan 8 kertas yang diharapkan', () => {
    expect(FILM).toHaveLength(20);
    expect(PAPER).toHaveLength(8);
    for (const id of [...FILM, ...PAPER]) {
      expect(stocksById.has(id), `stock hilang: ${id}`).toBe(true);
    }
    expect(manifest.stocks).toHaveLength(28);
  });

  it('LUT Hanatos berdimensi 192x192x81 dan f16', () => {
    expect(manifest.hanatos).toEqual({ width: 192, height: 192, bands: 81 });
    const bytes = readFileSync(join(DATA, 'hanatos.f16')).byteLength;
    expect(bytes).toBe(192 * 192 * 81 * 2);
  });

  it('offset stock bersambung tanpa celah dan menutupi seluruh blob', () => {
    let cursor = 0;
    for (const s of manifest.stocks as StockEntry[]) {
      expect(s.offsetFloats, s.id).toBe(cursor);
      cursor += s.lengthFloats;
    }
    const bytes = readFileSync(join(DATA, 'stocks.f32')).byteLength;
    expect(bytes).toBe(cursor * 4);
  });

  it('lengthFloats tiap stock sama dengan curvePoints * 4 (log_e + 3 kanal densitas)', () => {
    // Payload per stock adalah konkatenasi log_exposure (n) dengan
    // density_curves diratakan (n*3). Kalau offset/panjang salah tulis,
    // relasi aljabar ini adalah yang pertama pecah -- lebih murah
    // dideteksi di sini daripada lewat pergeseran data yang diam-diam
    // salah baca kurva stock lain.
    for (const s of manifest.stocks as StockEntry[]) {
      expect(s.lengthFloats, s.id).toBe(s.curvePoints * 4);
    }
  });

  it('tiap stock membawa metadata lisensi hulu', () => {
    for (const s of manifest.stocks as StockEntry[]) {
      expect(s.license, s.id).toBeTruthy();
      expect(s.citation, s.id).toBeTruthy();
    }
  });

  it('static.f32 (kompresi gamut keluaran) cocok dengan manifest dan tidak seluruhnya nol', () => {
    const entry = manifest.static.outputGamutCompression;
    const bytes = readFileSync(join(DATA, 'static.f32')).byteLength;
    expect(bytes).toBe(entry.lengthFloats * 4);
    const buf = readFileSync(join(DATA, 'static.f32'));
    const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    expect(floats.some((v) => v !== 0)).toBe(true);
  });

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
    const blob = readStocksBlob();
    for (const s of manifest.stocks as StockEntry[]) {
      const { densities } = readCurve(blob, s);
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
    const blob = readStocksBlob();
    const dmaxOf = (id: string) => {
      const s = stocksById.get(id)!;
      const { densities } = readCurve(blob, s);
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
