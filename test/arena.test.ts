import { describe, it, expect } from 'vitest';
import { ArenaBuilder, ArenaOverflowError, assertWithinStorageBufferLimit } from '../src/engine/arena';
import { acquireDevice } from '../src/engine/device';
import type { ArenaEntry } from '../src/engine/arena';

/**
 * Memverifikasi invarian tiling secara EXHAUSTIVE atas seluruh entri arena
 * (bukan spot-check dua entri): diurutkan berdasarkan offset, entri pertama
 * dimulai di 0, setiap entri berikutnya dimulai TEPAT di ujung entri
 * sebelumnya (tidak ada celah, tidak ada tumpang-tindih), dan jumlah seluruh
 * panjang sama dengan `totalFloats`. Satu float yang meleset satu posisi,
 * atau dua entri yang tumpang-tindih satu elemen, akan menggagalkan ini —
 * persis kelas bug yang task ini minta dibuktikan tidak ada, bukan diasumsikan
 * dari bentuk kode.
 */
function assertTilesExactly(entries: Record<string, ArenaEntry>, expectedTotalFloats: number): void {
  const sorted = Object.values(entries).sort((a, b) => a.offsetFloats - b.offsetFloats);
  let cursor = 0;
  for (const entry of sorted) {
    expect(entry.offsetFloats).toBe(cursor);
    cursor += entry.lengthFloats;
  }
  expect(cursor).toBe(expectedTotalFloats);
}

describe('ArenaBuilder', () => {
  it('menempatkan entri berurutan tanpa celah', async () => {
    const { device } = await acquireDevice();
    const builder = new ArenaBuilder();
    builder.add('cmfs', new Float32Array(81 * 3));
    builder.add('illuminant', new Float32Array(81));
    const arena = builder.build(device, 'static');

    expect(arena.entries.cmfs!.offsetFloats).toBe(0);
    expect(arena.entries.cmfs!.lengthFloats).toBe(243);
    expect(arena.entries.illuminant!.offsetFloats).toBe(243);
    expect(arena.entries.illuminant!.lengthFloats).toBe(81);
    arena.destroy();
  });

  it('memancarkan konstanta offset WGSL', async () => {
    const { device } = await acquireDevice();
    const builder = new ArenaBuilder();
    builder.add('cmfs', new Float32Array(12));
    const arena = builder.build(device, 'static');

    expect(arena.wgslConstants()).toContain('const ARENA_CMFS_OFFSET: u32 = 0u;');
    arena.destroy();
  });

  it('menolak nama entri yang sama dua kali', () => {
    const builder = new ArenaBuilder();
    builder.add('cmfs', new Float32Array(4));
    expect(() => builder.add('cmfs', new Float32Array(4))).toThrow(/sudah ada/i);
  });

  describe('tiling exhaustive atas banyak entri', () => {
    it('tidak punya celah maupun tumpang-tindih untuk sembarang jumlah/panjang entri, termasuk entri panjang nol', async () => {
      const { device } = await acquireDevice();
      const builder = new ArenaBuilder();
      // Panjang sengaja bervariasi (termasuk 0 dan 1) dan TIDAK diurutkan
      // menaik/menurun secara rapi, supaya invarian dibuktikan atas urutan
      // penambahan yang sewenang-wenang, bukan kasus yang sudah "rapi".
      const lengths: Array<[string, number]> = [
        ['cmfs', 243],
        ['illuminant-d65', 81],
        ['empty-table', 0],
        ['matrix', 9],
        ['single', 1],
        ['lut-26space', 26 * 4096],
        ['trailing-empty', 0],
      ];
      for (const [name, length] of lengths) builder.add(name, new Float32Array(length));
      const expectedTotal = lengths.reduce((sum, [, length]) => sum + length, 0);

      const arena = builder.build(device, 'static');

      expect(Object.keys(arena.entries)).toHaveLength(lengths.length);
      expect(arena.totalFloats).toBe(expectedTotal);
      assertTilesExactly(arena.entries, expectedTotal);
      // Ukuran buffer benar-benar dialokasikan harus cocok dengan panjang
      // total yang tercatat, byte demi byte — bukan cuma "cukup besar".
      expect(arena.buffer.size).toBe(expectedTotal * Float32Array.BYTES_PER_ELEMENT);

      arena.destroy();
    });

    it('entri panjang nol mewarisi offset entri berikutnya, bukan offset yang tidak terdefinisi', async () => {
      const { device } = await acquireDevice();
      const builder = new ArenaBuilder();
      builder.add('before', new Float32Array(4));
      builder.add('absent', new Float32Array(0));
      builder.add('after', new Float32Array(4));
      const arena = builder.build(device, 'static');

      expect(arena.entries.before!.offsetFloats).toBe(0);
      expect(arena.entries.absent!.offsetFloats).toBe(4);
      expect(arena.entries.absent!.lengthFloats).toBe(0);
      // 'absent' punya panjang nol, jadi 'after' mulai di offset yang SAMA
      // dengan 'absent' — bukan sebuah "celah" karena rentang 'absent' lebar
      // nol.
      expect(arena.entries.after!.offsetFloats).toBe(4);

      arena.destroy();
    });
  });

  describe('konstanta WGSL konsisten dengan offset tercatat (exhaustive)', () => {
    it('setiap entri memancarkan tepat satu baris const yang offsetnya cocok dengan arena.entries', async () => {
      const { device } = await acquireDevice();
      const builder = new ArenaBuilder();
      const names = ['alpha', 'beta_two', 'gamma-3', 'delta'];
      for (const [i, name] of names.entries()) builder.add(name, new Float32Array(i + 1));
      const arena = builder.build(device, 'static');

      const lines = arena.wgslConstants().trim().split('\n');
      expect(lines).toHaveLength(names.length);

      const parsed = new Map<string, number>();
      for (const line of lines) {
        const match = line.match(/^const ARENA_([A-Z0-9_]+)_OFFSET: u32 = (\d+)u;$/);
        expect(match).not.toBeNull();
        parsed.set(match![1]!, Number(match![2]));
      }

      for (const entry of Object.values(arena.entries)) {
        const canonical = entry.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
        expect(parsed.get(canonical)).toBe(entry.offsetFloats);
      }
      // Tidak ada baris ekstra yang tidak berasal dari entri manapun.
      expect(parsed.size).toBe(Object.keys(arena.entries).length);

      arena.destroy();
    });
  });

  describe('nama entri: validitas dan kolisi kanonikalisasi', () => {
    it('menolak nama kosong atau yang bukan identifier (spasi, diawali digit)', () => {
      const builder = new ArenaBuilder();
      expect(() => builder.add('', new Float32Array(1))).toThrow(/tidak sah/i);
      expect(() => builder.add('1cmfs', new Float32Array(1))).toThrow(/tidak sah/i);
      expect(() => builder.add('cm fs', new Float32Array(1))).toThrow(/tidak sah/i);
    });

    it('menolak dua nama berbeda yang hanya beda huruf besar/kecil', () => {
      const builder = new ArenaBuilder();
      builder.add('cmfs', new Float32Array(4));
      expect(() => builder.add('CMFS', new Float32Array(4))).toThrow(/konstanta WGSL yang sama/i);
    });

    it('menolak dua nama berbeda yang hanya beda tanda baca (- vs _)', () => {
      const builder = new ArenaBuilder();
      builder.add('cm-fs', new Float32Array(4));
      expect(() => builder.add('cm_fs', new Float32Array(4))).toThrow(/konstanta WGSL yang sama/i);
    });

    it('menerima nama berbeda yang tetap berbeda setelah dikanonikalisasi', () => {
      const builder = new ArenaBuilder();
      expect(() => {
        builder.add('cmfs', new Float32Array(1));
        builder.add('illuminant', new Float32Array(1));
      }).not.toThrow();
    });
  });

  describe('arena tanpa entri', () => {
    it('tetap membangun buffer valid berukuran minimum, tanpa entri maupun konstanta', async () => {
      const { device } = await acquireDevice();
      const builder = new ArenaBuilder();
      const arena = builder.build(device, 'frameState');

      expect(Object.keys(arena.entries)).toHaveLength(0);
      expect(arena.totalFloats).toBe(0);
      expect(arena.wgslConstants()).toBe('');
      expect(arena.buffer).toBeDefined();
      expect(arena.buffer.size).toBeGreaterThan(0);

      arena.destroy();
    });
  });

  describe('melebihi maxStorageBufferBindingSize', () => {
    // Diuji lewat fungsi angka murni yang diekstrak `build()`, bukan lewat
    // alokasi Float32Array sebesar limit device sungguhan (2 GiB pada
    // adapter yang diuji di sini) — lihat komentar di arena.ts.
    it('assertWithinStorageBufferLimit melempar ArenaOverflowError saat byteLength > limit', () => {
      expect(() => assertWithinStorageBufferLimit('stock', 17, 16)).toThrow(ArenaOverflowError);
    });

    it('pesan menyebut label, ukuran sebenarnya, dan limit — bukan galat generik tanpa konteks', () => {
      try {
        assertWithinStorageBufferLimit('stock', 17, 16);
        expect.unreachable('seharusnya melempar');
      } catch (err) {
        expect(err).toBeInstanceOf(ArenaOverflowError);
        const message = (err as Error).message;
        expect(message).toContain('stock');
        expect(message).toContain('17');
        expect(message).toContain('16');
      }
    });

    it('tidak melempar saat byteLength <= limit (termasuk tepat sama)', () => {
      expect(() => assertWithinStorageBufferLimit('stock', 16, 16)).not.toThrow();
      expect(() => assertWithinStorageBufferLimit('stock', 0, 16)).not.toThrow();
    });

    it('build() memanggil pemeriksaan ini dengan limit device yang sebenarnya, dan melempar SEBELUM createBuffer() disentuh', () => {
      const builder = new ArenaBuilder();
      // 5 float = 20 byte, sengaja 1 byte di atas limit tiruan 19 byte di
      // bawah. Device tiruan ini HANYA butuh `.limits.maxStorageBufferBindingSize`
      // — build() melempar sebelum pernah memanggil `.createBuffer()`, jadi
      // tidak perlu device WebGPU sungguhan untuk membuktikan pengkabelannya.
      builder.add('oversized', new Float32Array(5));
      const fakeDevice = {
        limits: { maxStorageBufferBindingSize: 19 },
        createBuffer(): never {
          throw new Error('createBuffer() TIDAK seharusnya dipanggil setelah overflow terdeteksi');
        },
      } as unknown as GPUDevice;

      expect(() => builder.build(fakeDevice, 'stock')).toThrow(ArenaOverflowError);
    });

    // Percobaan menambahkan satu titik data DEVICE SUNGGUHAN (bukan device
    // tiruan) untuk kasus overflow -- lewat `requestDeviceWithLimits(adapter,
    // {})`, yang memberi device limit DEFAULT spesifikasi WebGPU
    // (134217728 byte / 128 MiB untuk maxStorageBufferBindingSize, jauh
    // lebih murah dilampaui daripada limit maksimum adapter yang
    // `acquireDevice()` minta) -- DIBATALKAN setelah dicoba, bukan
    // dilewatkan begitu saja. Kode itu benar: direproduksi berdiri sendiri
    // lewat `npx vite-node` (memanggil getNavigatorGpu -> requestAdapter ->
    // requestDeviceWithLimits(adapter, {}) -> ArenaBuilder.add() dengan
    // Float32Array 33.554.433 float [~128 MiB] -> builder.build() -> tertangkap
    // ArenaOverflowError, persis seperti diharapkan). Tapi jalur yang SAMA
    // dijalankan lewat `npx vitest run` mematikan worker Vitest
    // ("Worker exited unexpectedly" / ChildProcess exit) SETIAP kali --
    // baik dengan satu Float32Array besar maupun dipecah jadi banyak
    // Float32Array kecil yang jumlahnya sama (~129 x 1 MiB), jadi bukan soal
    // ukuran satu alokasi. Sebuah alokasi ~128 MiB TANPA device WebGPU sama
    // sekali terbukti aman di Vitest (test kontrol terpisah, RSS nyaris
    // tidak berubah -- typed array besar zero-fill lazy, bukan benar-benar
    // di-commit). Jadi penyebabnya spesifik kombinasi device WebGPU
    // sungguhan (Dawn, lewat paket `webgpu`) dengan alokasi JS besar di
    // dalam worker/proses fork Vitest -- bukan bug di arena.ts, dan
    // memaksakannya akan membuat SELURUH test file gagal (worker yang mati
    // menandai semua test di file itu error, bukan cuma satu test ini).
    // Sesuai izin eksplisit peninjau ("kalau ada alasan lain yang membuat
    // ini tidak bisa dilakukan, katakan saja dan biarkan seperti sekarang"),
    // substitusi yang sudah ada (assertWithinStorageBufferLimit teruji
    // langsung, plus test wiring build() dengan device tiruan di atas) tetap
    // menjadi bukti untuk jalur ini.
  });

  describe('sekali-bangun ditegakkan (bukan sekadar didokumentasikan)', () => {
    it('build() kedua pada builder yang sama melempar, bukan diam-diam membangun arena yang menumpuk entri lama dan baru', async () => {
      const { device } = await acquireDevice();
      const builder = new ArenaBuilder();
      builder.add('cmfs', new Float32Array(4));
      const first = builder.build(device, 'static');

      expect(() => builder.build(device, 'static-lagi')).toThrow(/sudah dibangun/i);

      first.destroy();
    });

    it('add() setelah build() melempar, bukan diam-diam menambah entri ke builder yang sudah terpakai', async () => {
      const { device } = await acquireDevice();
      const builder = new ArenaBuilder();
      builder.add('cmfs', new Float32Array(4));
      const arena = builder.build(device, 'static');

      expect(() => builder.add('illuminant', new Float32Array(4))).toThrow(/sudah dibangun/i);

      arena.destroy();
    });
  });

  describe('destroy()', () => {
    it('membuat .buffer melempar galat jelas setelah dipanggil, bukan mengembalikan buffer yang sudah tidak valid', async () => {
      const { device } = await acquireDevice();
      const builder = new ArenaBuilder();
      builder.add('cmfs', new Float32Array(4));
      const arena = builder.build(device, 'static');

      arena.destroy();

      expect(() => arena.buffer).toThrow(/destroy/i);
    });

    it('bersifat idempoten — destroy() kedua tidak melempar', async () => {
      const { device } = await acquireDevice();
      const builder = new ArenaBuilder();
      builder.add('cmfs', new Float32Array(4));
      const arena = builder.build(device, 'static');

      arena.destroy();
      expect(() => arena.destroy()).not.toThrow();
    });

    it('.entries dan .wgslConstants() tetap terbaca setelah destroy() — keduanya pembukuan TypeScript, bukan state GPU', async () => {
      const { device } = await acquireDevice();
      const builder = new ArenaBuilder();
      builder.add('cmfs', new Float32Array(4));
      const arena = builder.build(device, 'static');

      arena.destroy();

      expect(arena.entries.cmfs!.offsetFloats).toBe(0);
      expect(arena.wgslConstants()).toContain('ARENA_CMFS_OFFSET');
    });
  });
});
