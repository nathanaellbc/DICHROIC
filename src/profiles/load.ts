import {
  STOCK_FIELD_NAMES,
  STATIC_TABLE_NAMES,
  type BlobRef,
  type Manifest,
  type ReadonlyFloat32Array,
  type Stock,
  type StockEntry,
  type StockFieldName,
  type StaticTableName,
} from './types';

export {
  STOCK_FIELD_NAMES,
  STATIC_TABLE_NAMES,
  type BlobRef,
  type Manifest,
  type ReadonlyFloat32Array,
  type Stock,
  type StockEntry,
  type StockFieldName,
  type StaticTableName,
};

/**
 * Aset ter-bake, dimuat dan siap dipakai lewat satu titik masuk. Setiap
 * larik yang dikembalikan adalah *view* (`subarray`) ke buffer blob yang
 * dimuat sekali -- tidak ada penyalinan per akses, dan NaN celah pengukuran
 * hulu (lihat `nullCount` di manifest) tetap NaN, tidak disaring maupun
 * diubah jadi nol.
 */
export interface AssetBundle {
  readonly manifest: Manifest;
  /** Blob mentah `stocks.f32`, untuk akses tingkat rendah bila perlu. */
  readonly stocks: ReadonlyFloat32Array;
  /** LUT Hanatos, sudah diekspansi dari f16 ke f32 (lihat `expandF16`). */
  readonly hanatos: ReadonlyFloat32Array;
  /** Blob mentah `static.f32`. */
  readonly static: ReadonlyFloat32Array;
  /** Metadata satu stock. Melempar galat untuk id yang tidak dikenal. */
  stockEntry(id: string): StockEntry;
  /**
   * Salah satu dari 23 field larik milik satu stock, sebagai view ke
   * `stocks`. Mengembalikan `null` hanya jika field itu SAH tidak berlaku
   * untuk stock ini (satu-satunya kasus nyata: `bandpassHanatos2025` pada
   * stock kertas). Melempar galat untuk id stock atau nama field yang tidak
   * dikenal -- tidak pernah mengembalikan larik kosong sebagai pengganti
   * galat.
   */
  stockField(id: string, field: StockFieldName): ReadonlyFloat32Array | null;
  /**
   * Salah satu dari 14 tabel global, sebagai view ke `static`. Melempar
   * galat untuk nama tabel yang tidak dikenal. Ke-4 tabel
   * `academyPrinterDensity*` kembali bernilai nol ketika
   * `manifest.counts.academyPrinterDensityEnabled` bernilai false -- itu
   * fitur nonaktif hulu, bukan celah data (beda dari NaN `nullCount`).
   */
  staticTable(name: StaticTableName): ReadonlyFloat32Array;
  /** Kurva H&D siap pakai (logExposure + densityCurves) untuk satu stock. */
  stock(id: string): Stock;
}

/**
 * Ekspansi satu nilai IEEE 754 binary16 ke nilai matematis penuhnya (sebagai
 * `number`/float64 JS). Dievaluasi dari definisi bit half-float secara
 * langsung -- bukan geser-bit yang meniru pola bit f32 -- sehingga
 * subnormal (exponent 0, mantissa != 0), nol bertanda (exponent 0, mantissa
 * == 0), dan +-Infinity/NaN (exponent seluruhnya 1) semuanya benar tanpa
 * kasus khusus yang rawan salah. Setiap nilai half (termasuk subnormal
 * terkecilnya, 2^-24) terwakili PERSIS oleh float64 maupun float32 (f32
 * punya 23 bit mantissa vs. 10 bit half), jadi pembulatan ke float32 saat
 * ditulis ke `Float32Array` di `expandF16` tidak kehilangan presisi apa pun.
 */
function halfToFloat(h: number): number {
  const sign = (h & 0x8000) !== 0 ? -1 : 1;
  const exponent = (h & 0x7c00) >> 10;
  const mantissa = h & 0x03ff;
  if (exponent === 0) {
    // Subnormal (atau nol bertanda jika mantissa === 0): nilai = mantissa * 2^-24.
    return sign * mantissa * 2 ** -24;
  }
  if (exponent === 0x1f) {
    return mantissa === 0 ? sign * Infinity : NaN;
  }
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
}

/**
 * Ekspansi LUT Hanatos dari f16 ke f32. Ini satu-satunya tempat di proyek
 * di mana presisi transport (f16, seperti dikirim `hanatos.f16`) berbeda
 * dari presisi komputasi (f32) -- spec melarang jalur f16 di shader, jadi
 * ekspansi wajib terjadi di sini, sekali, saat muat.
 *
 * Diverifikasi bit-exact terhadap `np.float16(...).astype(np.float32)`
 * NumPy atas seluruh 2.985.984 elemen `hanatos.f16` sungguhan (termasuk
 * 168.155 subnormal di LUT itu) -- lihat task-5-report.md untuk perintah
 * dan hasil penuh.
 */
export function expandF16(src: Uint16Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 1) {
    out[i] = halfToFloat(src[i]!);
  }
  return out;
}

/**
 * Baca `url` sebagai byte mentah. Di browser (atau kalau `url` sudah berupa
 * URL http/https absolut), lewat `fetch`; sebaliknya (Node, path
 * relatif/absolut lokal -- jalur yang dipakai test) lewat `node:fs`.
 */
async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (isBrowser || /^https?:\/\//.test(url)) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Gagal memuat ${url}: ${response.status} ${response.statusText}`);
    }
    return response.arrayBuffer();
  }
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(url);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const STOCK_FIELD_NAME_SET: ReadonlySet<string> = new Set(STOCK_FIELD_NAMES);
const STATIC_TABLE_NAME_SET: ReadonlySet<string> = new Set(STATIC_TABLE_NAMES);

function assertKnownField(field: string): void {
  if (!STOCK_FIELD_NAME_SET.has(field)) {
    throw new Error(
      `Field stock tidak dikenal: "${field}". Field yang sah: ${STOCK_FIELD_NAMES.join(', ')}`,
    );
  }
}

function assertKnownTable(name: string): void {
  if (!STATIC_TABLE_NAME_SET.has(name)) {
    throw new Error(
      `Tabel global tidak dikenal: "${name}". Tabel yang sah: ${STATIC_TABLE_NAMES.join(', ')}`,
    );
  }
}

function sliceRef(blob: Float32Array, ref: BlobRef): ReadonlyFloat32Array {
  return blob.subarray(ref.offsetFloats, ref.offsetFloats + ref.lengthFloats);
}

export async function loadAssets(baseUrl: string): Promise<AssetBundle> {
  const join = (name: string) => `${baseUrl.replace(/\/$/, '')}/${name}`;

  // Tidak ada validasi skema runtime di sini -- ini percaya begitu saja pada
  // bentuk JSON. Pengamannya adalah test suite (`test/assets.test.ts` +
  // `test/profiles.test.ts`), yang menutup seluruh bentuk manifest (23
  // field per stock, 14 tabel global, offset/panjang, nullCount, dst.)
  // secara langsung terhadap berkas nyata. Kalau baker berubah bentuk lagi,
  // test itulah yang akan gagal duluan -- bukan cast di baris ini.
  const manifest = JSON.parse(
    new TextDecoder().decode(await fetchBytes(join('manifest.json'))),
  ) as Manifest;

  const stocks = new Float32Array(await fetchBytes(join('stocks.f32')));
  const hanatos = expandF16(new Uint16Array(await fetchBytes(join('hanatos.f16'))));
  const staticTables = new Float32Array(await fetchBytes(join('static.f32')));

  const byId = new Map(manifest.stocks.map((s) => [s.id, s]));

  function stockEntry(id: string): StockEntry {
    const entry = byId.get(id);
    if (!entry) {
      throw new Error(`Stock tidak dikenal: "${id}". Tersedia: ${[...byId.keys()].join(', ')}`);
    }
    return entry;
  }

  function stockField(id: string, field: StockFieldName): ReadonlyFloat32Array | null {
    const entry = stockEntry(id);
    assertKnownField(field);
    const ref = entry.fields[field];
    return ref ? sliceRef(stocks, ref) : null;
  }

  function staticTable(name: StaticTableName): ReadonlyFloat32Array {
    assertKnownTable(name);
    return sliceRef(staticTables, manifest.static[name]);
  }

  function stock(id: string): Stock {
    const entry = stockEntry(id);
    const logExposure = stockField(id, 'logExposure');
    const densityCurves = stockField(id, 'densityCurves');
    if (!logExposure || !densityCurves) {
      // Tidak terjadi pada data nyata (hanya bandpassHanatos2025 boleh
      // null), tapi dijaga eksplisit agar kegagalan diam-diam tak mungkin
      // lolos kalau upstream berubah.
      throw new Error(`Stock "${id}" tidak punya logExposure/densityCurves.`);
    }
    return { entry, logExposure, densityCurves };
  }

  return {
    manifest,
    stocks,
    hanatos,
    static: staticTables,
    stockEntry,
    stockField,
    staticTable,
    stock,
  };
}
