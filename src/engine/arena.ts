/**
 * Arena: mengumpulkan tabel read-only kecil ke dalam satu storage buffer,
 * diakses lewat konstanta offset yang dipancarkan ke sumber WGSL.
 *
 * WebGPU menjamin hanya 8 storage buffer per shader stage untuk device
 * konforman apa pun (lihat `device.ts`, `MIN_STORAGE_BUFFERS_PER_STAGE`).
 * Kernel terbesar hulu, SpektraPrintScan, mengikat 30 — bahkan pada 16
 * storage buffer yang ditawarkan adapter di sini pun tidak muat. Sebagian
 * besar dari ke-30 itu adalah tabel lookup kecil (CMF, illuminant, matriks,
 * LUT 26-ruang-warna, kurva densitas, dll.), jadi solusinya BUKAN meminta
 * lebih banyak binding dari device (itu akan membuat engine bergantung pada
 * perangkat yang lebih murah hati dan gagal di device lain yang hanya
 * menjamin 8), melainkan mengepak beberapa tabel ke satu buffer dan
 * membedakannya lewat offset.
 *
 * Tabel dikelompokkan menurut KAPAN isinya berubah (spec §4.3):
 *   - `static`     — tetap sejak load: CMF observer, illuminant, matriks,
 *                    LUT 26-ruang-warna.
 *   - `stock`      — berubah bersama film/paper yang dipilih: kurva
 *                    densitas, densitas kanal, log sensitivity.
 *   - `dynamic`    — berubah bersama parameter: respons enlarger, respons
 *                    Hanatos, filter, matriks scan.
 *   - `frameState` — scratch per-dispatch.
 *
 * Empat kelompok ini menjadi empat `Arena` terpisah (lih. `Arenas` di
 * bawah) — masing-masing satu storage buffer, satu binding. Task 11
 * mengisinya dari `AssetBundle` (Task 5); modul ini hanya menyediakan
 * kontainer dan pembukuan offsetnya.
 *
 * BAHAYA YANG DIRANCANG UNTUK DICEGAH DI SINI: offset yang salah tidak
 * pernah gagal secara terlihat. Buffer tetap berukuran benar, shader tetap
 * terkompilasi, dispatch tetap berjalan — hasilnya cuma gambar yang salah
 * secara masuk akal (tabel A membaca sebagian tabel B). Karena itu setiap
 * invarian di sini (tiling tanpa celah/tumpang-tindih, konstanta WGSL yang
 * konsisten dengan offset tercatat, panjang total yang cocok dengan ukuran
 * buffer) HARUS dibuktikan lewat test, bukan dipercaya dari bentuk kode.
 */

/**
 * `GPUBufferUsage` adalah GLOBAL bawaan browser, tidak dipasang di
 * Node/Vitest -- lihat dokumentasi lengkapnya di `webgpuGlobals.ts`, yang
 * sejak Task 9 menjadi satu-satunya tempat resolusi ini terjadi (sebelumnya
 * blok ini diduplikasi verbatim di sini, `graph.ts`, dan `graph.test.ts`).
 * `build()` sendiri tetap sinkron (kontrak task-8-brief.md: `build(device,
 * label): Arena`, bukan `Promise<Arena>`) -- resolusi di `webgpuGlobals.ts`
 * terjadi sekali lewat top-level await saat modul itu dimuat, sebelum
 * `build()` pernah dipanggil.
 */
import { gpuBufferUsage } from './webgpuGlobals';

/** Satu entri tabel yang dipetakan ke dalam sebuah arena. */
export interface ArenaEntry {
  name: string;
  offsetFloats: number;
  lengthFloats: number;
}

export interface Arena {
  buffer: GPUBuffer;
  entries: Record<string, ArenaEntry>;
  /**
   * Jumlah total float yang benar-benar dicatat entri (bukan ukuran alokasi
   * buffer, yang bisa dibulatkan naik — lihat `MIN_ARENA_BUFFER_BYTES` di
   * bawah untuk kasus arena kosong). Tambahan di luar minimum task-8-brief.md,
   * agar pemanggil (dan test) bisa membuktikan "panjang total cocok dengan
   * buffer" tanpa menebak dari `entries` atau dari `buffer.size`.
   */
  totalFloats: number;
  /** Satu baris `const ARENA_<NAMA>_OFFSET: u32 = <n>u;` per entri. */
  wgslConstants(): string;
  /**
   * Menghancurkan buffer GPU. Idempoten (destroy() kedua adalah no-op,
   * konsisten dengan `GPUBuffer.destroy()` sendiri) — TAPI setelah dipanggil,
   * mengakses `.buffer` melempar galat yang jelas alih-alih diam-diam
   * mengembalikan `GPUBuffer` yang sudah tidak valid (yang baru gagal jauh
   * kemudian, di titik bind group, dengan galat validasi WebGPU generik).
   * `.entries` dan `.wgslConstants()` tetap bisa dibaca setelah destroy —
   * keduanya cuma data pembukuan TypeScript, tidak menyentuh GPU, jadi tidak
   * ada alasan mempersulit pemanggil yang mis. masih ingin memancarkan
   * konstanta WGSL untuk logging setelah arena dibuang.
   */
  destroy(): void;
}

/**
 * Kumpulan arena yang dipakai bersama seluruh tahap, dikelompokkan menurut
 * kapan isinya berubah. Lihat spec §4.3. Task 11 (`buildArenas`) adalah
 * pembuat pertama nilai bertipe ini; Task 12-18 mengonsumsinya lewat offset
 * yang tercatat pada tiap `Arena`.
 */
export interface Arenas {
  static: Arena;
  stock: Arena;
  dynamic: Arena;
  frameState: Arena;
}

/**
 * Arena tanpa entri (belum pernah dipanggil `add()`) tetap harus menjadi
 * `GPUBuffer` yang valid — WebGPU tidak mengizinkan buffer berukuran 0 pada
 * beberapa implementasi, dan bahkan bila diizinkan, sebuah bind group yang
 * menunjuk buffer 0-byte adalah kasus tepi yang tidak berguna untuk diuji di
 * device sungguhan. Satu float (4 byte) dipilih sebagai lantai: kelipatan 4
 * (persyaratan alignment storage buffer), sekecil mungkin, dan TIDAK PERNAH
 * diacu oleh konstanta offset apa pun karena `entries` tetap kosong —
 * placeholder ini murni untuk membuat `buffer` valid, bukan data yang
 * dimaksudkan untuk dibaca shader.
 */
const MIN_ARENA_BUFFER_BYTES = 4;

/**
 * Melempar bila `byteLength` (ukuran arena yang sebenarnya akan dialokasikan)
 * melebihi `limit` (device.limits.maxStorageBufferBindingSize yang sebenarnya
 * diberikan device pada Task 6 — lihat `acquireDevice()`, yang memintanya
 * sebesar maksimum adapter demi kebijakan "kualitas di atas performa").
 *
 * WebGPU TIDAK melempar secara sinkron untuk `createBuffer()` yang melebihi
 * limit ini — kegagalannya masuk ke error scope device (log konsol,
 * mengembalikan buffer "tidak valid" yang lolos ke pemanggil) dan lanjut
 * jalan. Itu persis pola "gagal secara senyap, gambar salah secara masuk
 * akal" yang modul ini ada untuk dicegah, jadi pemeriksaan ini HARUS terjadi
 * di sini, sebelum `createBuffer()` dipanggil, dengan galat sinkron yang
 * menyebut kedua angka.
 *
 * Diekstrak sebagai fungsi angka murni (bukan mengambil `GPUDevice`) supaya
 * bisa diuji langsung dengan limit kecil sembarang, tanpa mengalokasikan
 * data sungguhan sebesar limit device nyata untuk memicunya — pada adapter
 * yang diuji di sini `maxStorageBufferBindingSize` adalah 2 GiB, dan
 * mengalokasikan Float32Array 2 GiB di setiap jalan test hanya untuk memicu
 * jalur ini akan membuat test lambat dan boros memori tanpa menambah bukti.
 */
export function assertWithinStorageBufferLimit(
  label: string,
  byteLength: number,
  limit: number,
): void {
  // Ketat "lebih besar dari", bukan ">=": maxStorageBufferBindingSize adalah
  // batas atas INKLUSIF pada spesifikasi WebGPU (ukuran binding storage
  // buffer boleh SAMA DENGAN limit, hanya tidak boleh melampauinya), jadi
  // arena yang pas mengisi limit persis harus tetap boleh dibangun.
  if (byteLength > limit) {
    throw new ArenaOverflowError(label, byteLength, limit);
  }
}

/**
 * Dibedakan dari `Error` biasa agar pemanggil (mis. Task 11 saat memutuskan
 * apakah harus men-tile ulang tabel, bukan menganggapnya bug) bisa
 * membedakan lewat `instanceof`, sama seperti pola
 * `WebGPUDeviceRequestError` di `device.ts`.
 */
export class ArenaOverflowError extends Error {
  constructor(label: string, byteLength: number, limit: number) {
    super(
      `Arena '${label}' berukuran ${byteLength} byte, melebihi ` +
        `maxStorageBufferBindingSize device (${limit} byte). ` +
        'Pecah tabel yang dipetakan ke arena ini menjadi lebih dari satu ' +
        'arena, atau kurangi apa yang dipetakan — arena TIDAK dibuat.',
    );
    this.name = 'ArenaOverflowError';
  }
}

/**
 * Mengubah nama entri menjadi identifier WGSL yang aman: huruf besar,
 * karakter non-alfanumerik (termasuk run berurutan) dilebur jadi satu `_`.
 *
 * Ada demi satu bahaya spesifik: sebuah arena bisa menampung beberapa lusin
 * entri, dan `wgslConstants()` memancarkan `ARENA_<NAMA>_OFFSET` dari nama
 * itu. Dua nama entri yang BERBEDA sebagai string TypeScript tapi berubah
 * jadi identik setelah kanonikalisasi ini (mis. `cmfs` vs `CMFS`, atau
 * `cm-fs` vs `cm_fs`) akan memancarkan DUA baris `const` dengan nama sama —
 * WGSL menolaknya sebagai redeklarasi HANYA jika keduanya disambung ke
 * shader yang sama; kalau tidak, salah satu offset diam-diam mengalahkan
 * yang lain tergantung urutan penyambungan, dan pembaca kode tidak akan
 * melihat tanda apa pun. `add()` di bawah memanggil fungsi ini untuk
 * mendeteksi kolisi SAAT ditambahkan, bukan saat WGSL dipancarkan.
 */
function canonicalConstantName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Nama entri arena yang sah: diawali huruf, lalu huruf/digit/`_`/`-`.
 * Ini bukan sekadar higienis — nama entri yang kosong, berawal digit, atau
 * berisi spasi/karakter lain akan tetap "berhasil" dikanonikalisasi oleh
 * `canonicalConstantName` menjadi sesuatu seperti `_` tunggal, yang lebih
 * mudah berkolisi dengan entri lain yang juga aneh. Menolaknya di titik
 * `add()` membuat penyebabnya jelas, bukan tersembunyi di balik pesan
 * kolisi kanonikalisasi yang lebih umum.
 */
const VALID_ENTRY_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Mengumpulkan tabel read-only kecil ke dalam satu storage buffer.
 *
 * Pemakaian: panggil `add()` berulang (urutan panggilan == urutan tiling di
 * buffer), lalu `build()` SEKALI untuk memperoleh `Arena` yang sudah
 * mengunggah data ke GPU. `ArenaBuilder` sendiri tidak menyentuh GPU sampai
 * `build()` dipanggil, jadi bisa dipakai sepenuhnya di luar test yang
 * memerlukan device (lih. test "menolak nama entri yang sama dua kali").
 *
 * Sekali-bangun ditegakkan, bukan cuma didokumentasikan: builder ini
 * mengunci dirinya sendiri di `build()` (lihat `#built`). Memanggil `add()`
 * atau `build()` lagi pada instance yang sama SETELAH `build()` pertama akan
 * melempar. Alasannya bukan higienis — Task 11 membangun EMPAT arena
 * (static/stock/dynamic/frameState) berturut-turut; bila satu builder
 * terpakai ulang karena salah salin-tempel, `add()` kedua akan menumpuk di
 * atas `cursor` yang sudah maju dari `build()` pertama, menghasilkan arena
 * kedua yang ukurannya masuk akal tapi berisi entri lama DAN baru pada
 * offset yang salah — diam-diam, tanpa galat kompilasi atau galat WebGPU
 * apa pun. Itu persis kelas bug yang modul ini ada untuk mencegah, jadi
 * niat "sekali-bangun" yang cuma tertulis di komentar tidak cukup.
 */
export class ArenaBuilder {
  private readonly chunks: Array<{ entry: ArenaEntry; data: Float32Array }> = [];
  private readonly usedNames = new Set<string>();
  /** kanonik -> nama asli, untuk pesan galat kolisi yang menyebut keduanya. */
  private readonly canonicalToName = new Map<string, string>();
  private cursor = 0;
  #built = false;

  /**
   * Menambahkan satu tabel ke posisi berikutnya dalam arena (offset =
   * jumlah float seluruh entri sebelumnya). Panjang nol DIPERBOLEHKAN
   * secara sengaja: sebuah tabel yang tidak berlaku untuk konfigurasi
   * tertentu (mis. salah satu dari 16 tabel akses global yang Task 4/11
   * catat sebagai "counts.xEnabled=false") boleh dipetakan dengan
   * `new Float32Array(0)` alih-alih dilewatkan sama sekali — offsetnya tetap
   * tercatat dan konsisten (sama dengan offset entri berikutnya, karena
   * rentangnya lebar nol), dan shader yang membacanya di luar batas 0-elemen
   * itu sudah salah terlepas dari bagaimana arena ini dibangun.
   */
  add(name: string, data: Float32Array): void {
    if (this.#built) {
      throw new Error(
        `ArenaBuilder ini sudah dibangun (build() sudah dipanggil) — tidak bisa ` +
          `menambahkan entri '${name}' lagi. Buat ArenaBuilder baru untuk arena ` +
          'berikutnya alih-alih memakai ulang instance ini.',
      );
    }
    if (!VALID_ENTRY_NAME.test(name)) {
      throw new Error(
        `Nama entri arena '${name}' tidak sah — harus diawali huruf dan hanya ` +
          'berisi huruf/digit/_/- (agar tidak berkolisi secara diam-diam ' +
          'setelah dikanonikalisasi menjadi konstanta WGSL).',
      );
    }
    if (this.usedNames.has(name)) {
      throw new Error(`Entri arena '${name}' sudah ada`);
    }

    const canonical = canonicalConstantName(name);
    const existing = this.canonicalToName.get(canonical);
    if (existing !== undefined) {
      throw new Error(
        `Entri arena '${name}' menghasilkan konstanta WGSL yang sama ` +
          `(ARENA_${canonical}_OFFSET) dengan entri '${existing}' yang sudah ` +
          'ditambahkan — beda hanya di huruf besar/kecil atau tanda baca. ' +
          'Pilih nama yang benar-benar berbeda setelah dikanonikalisasi.',
      );
    }

    this.usedNames.add(name);
    this.canonicalToName.set(canonical, name);
    this.chunks.push({
      entry: { name, offsetFloats: this.cursor, lengthFloats: data.length },
      data,
    });
    this.cursor += data.length;
  }

  /**
   * Menyalin seluruh entri yang terkumpul ke satu `GPUBuffer` dan
   * mengembalikan `Arena` yang mengekspos offset-nya. Boleh dipanggil dengan
   * NOL entri (arena kosong) — lihat `MIN_ARENA_BUFFER_BYTES` di atas untuk
   * kenapa itu tetap menghasilkan buffer valid, bukan galat.
   *
   * @throws ArenaOverflowError bila total ukuran melebihi
   *   `device.limits.maxStorageBufferBindingSize`.
   * @throws Error bila builder ini sudah pernah di-`build()` sebelumnya.
   */
  build(device: GPUDevice, label: string): Arena {
    if (this.#built) {
      throw new Error(
        `ArenaBuilder ini sudah dibangun sekali (label sebelumnya boleh jadi ` +
          `berbeda dari '${label}') — build() kedua pada instance yang sama akan ` +
          'menghasilkan arena yang menumpuk entri lama dan baru pada offset yang ' +
          'salah, secara diam-diam. Buat ArenaBuilder baru untuk setiap arena.',
      );
    }
    this.#built = true;

    const totalFloats = this.cursor;
    const byteLength = totalFloats * Float32Array.BYTES_PER_ELEMENT;
    assertWithinStorageBufferLimit(label, byteLength, device.limits.maxStorageBufferBindingSize);

    const combined = new Float32Array(totalFloats);
    for (const { entry, data } of this.chunks) {
      combined.set(data, entry.offsetFloats);
    }

    const buffer = device.createBuffer({
      label: `arena:${label}`,
      size: Math.max(byteLength, MIN_ARENA_BUFFER_BYTES),
      usage: gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Float32Array(buffer.getMappedRange()).set(combined);
    buffer.unmap();

    const entries: Record<string, ArenaEntry> = {};
    for (const { entry } of this.chunks) {
      entries[entry.name] = Object.freeze({ ...entry });
    }
    Object.freeze(entries);

    return new ArenaImpl(buffer, entries, totalFloats, label);
  }
}

/**
 * Implementasi `Arena`. Bukan literal objek (seperti draf awal
 * task-8-brief.md) supaya `.buffer` bisa dijaga lewat accessor: setelah
 * `destroy()`, membaca `.buffer` melempar galat jelas alih-alih diam-diam
 * mengembalikan `GPUBuffer` yang sudah dihancurkan.
 */
class ArenaImpl implements Arena {
  #buffer: GPUBuffer;
  #destroyed = false;
  readonly entries: Record<string, ArenaEntry>;
  readonly totalFloats: number;
  private readonly label: string;

  constructor(
    buffer: GPUBuffer,
    entries: Record<string, ArenaEntry>,
    totalFloats: number,
    label: string,
  ) {
    this.#buffer = buffer;
    this.entries = entries;
    this.totalFloats = totalFloats;
    this.label = label;
  }

  get buffer(): GPUBuffer {
    if (this.#destroyed) {
      throw new Error(
        `Arena '${this.label}' sudah di-destroy() — buffer GPU-nya tidak lagi valid.`,
      );
    }
    return this.#buffer;
  }

  /**
   * Satu-satunya sumber offset yang dipancarkan adalah `this.entries` yang
   * sama dengan yang diekspos publik lewat properti `entries` — TIDAK ada
   * salinan terpisah yang bisa diam-diam menyimpang darinya. Setiap baris
   * dipancarkan langsung dari `entry.offsetFloats` yang tercatat `build()`,
   * lewat fungsi kanonikalisasi yang sama dengan yang mendeteksi kolisi di
   * `add()` — jadi nama konstanta di sini juga tidak bisa menyimpang dari
   * pemeriksaan kolisi itu.
   */
  wgslConstants(): string {
    return Object.values(this.entries)
      .map((e) => `const ARENA_${canonicalConstantName(e.name)}_OFFSET: u32 = ${e.offsetFloats}u;`)
      .join('\n');
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#buffer.destroy();
    this.#destroyed = true;
  }
}
