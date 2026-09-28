import { importDawn } from './dawn';
export class WebGPUUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `DICHROIC memerlukan WebGPU, yang tidak tersedia di sini: ${reason}. ` +
        'Dukungan tersedia di Chrome 113+, Edge 113+, Safari 26+, dan Firefox 141+. ' +
        'Tidak ada jalur render alternatif — seluruh pipeline berjalan sebagai compute shader.',
    );
    this.name = 'WebGPUUnavailableError';
  }
}

/**
 * Berbeda dari WebGPUUnavailableError secara sengaja: di sini WebGPU ITU ADA
 * (browser/adapter cocok), tetapi permintaan device dengan limit tertentu
 * ditolak — biasanya karena kita meminta maxStorageBufferBindingSize/
 * maxBufferSize pada maksimum adapter (kebijakan "kualitas di atas
 * performa"), dan perangkat ini tidak menyanggupinya. Tindakan pengguna
 * berbeda pula: bukan "ganti browser", melainkan "coba render dengan limit
 * lebih rendah, atau pakai perangkat lain". Pemanggil membedakan lewat
 * `instanceof`, bukan mencocokkan teks pesan.
 */
export class WebGPUDeviceRequestError extends Error {
  constructor(reason: string) {
    super(
      `Adapter WebGPU ditemukan, tetapi menolak limit device yang diminta: ${reason}. ` +
        'Perangkat ini mungkin tidak sanggup untuk render penuh pada limit tersebut — ' +
        'coba lagi dengan permintaan limit yang lebih rendah, atau gunakan perangkat/browser lain.',
    );
    this.name = 'WebGPUDeviceRequestError';
  }
}

export interface EngineDevice {
  device: GPUDevice;
  limits: GPUSupportedLimits;
  maxStorageBufferBindingSize: number;
}

/** Minimum storage buffer per shader stage yang dijamin spesifikasi WebGPU untuk device apa pun yang konforman. */
const MIN_STORAGE_BUFFERS_PER_STAGE = 8;

/**
 * WebGPU menjamin minimal 8 storage buffer per shader stage untuk device
 * konforman apa pun — jadi kondisi ini semestinya mustahil terjadi.
 * Dipertahankan sebagai LEMPAR, bukan dihapus atau di-log-lalu-lanjut,
 * dengan alasan: biayanya nol (satu perbandingan), dan bila kondisi
 * "mustahil" ini toh terjadi (device non-konforman, bug driver, harness
 * pengujian yang aneh), ia mengubah kegagalan itu dari galat validasi
 * bind-group WebGPU yang generik dan jauh dari penyebabnya — kemungkinan
 * muncul di Task 17 saat mengikat enam binding shader hulu — menjadi galat
 * yang dekat, jelas, dan bisa ditindaklanjuti persis di titik akuisisi
 * device. Device yang tidak menyanggupi batas terjamin ini bukan device
 * WebGPU yang bisa dipakai engine ini sama sekali, yang persis situasi
 * yang WebGPUUnavailableError ada untuk menyampaikannya.
 *
 * Diekstrak agar bisa diuji langsung dengan objek limit tiruan, tanpa
 * menyentuh device WebGPU sungguhan.
 */
export function assertGuaranteedStorageBufferLimit(
  limits: Pick<GPUSupportedLimits, 'maxStorageBuffersPerShaderStage'>,
): void {
  if (limits.maxStorageBuffersPerShaderStage < MIN_STORAGE_BUFFERS_PER_STAGE) {
    throw new WebGPUUnavailableError(
      `device melaporkan hanya ${limits.maxStorageBuffersPerShaderStage} storage buffer per shader stage, ` +
        `di bawah minimum ${MIN_STORAGE_BUFFERS_PER_STAGE} yang dijamin spesifikasi WebGPU untuk device konforman apa pun`,
    );
  }
}

/**
 * Deteksi lingkungan berdasarkan keberadaan `navigator.gpu` yang sebenarnya,
 * bukan pola URL atau nama platform yang hanya berkorelasi dengannya (lih.
 * catatan Task 5 tentang `fetchBytes`). Di browser dengan dukungan WebGPU,
 * `navigator.gpu` ada dan dipakai langsung. Di lingkungan lain (Node/Vitest,
 * atau browser tanpa WebGPU), turun ke paket `webgpu` (Dawn) sebagai satu-
 * satunya jalur pengujian — bila itu pun tidak tersedia, error yang sebenarnya
 * dari impornya diteruskan sebagai alasan.
 */
let dawnGpu: Promise<GPU> | undefined;

export async function getNavigatorGpu(): Promise<GPU> {
  if (typeof navigator !== 'undefined' && navigator.gpu) return navigator.gpu;
  // Di-memo per proses SENGAJA. `navigator.gpu` di browser sudah singleton;
  // `create()` milik paket `webgpu` tidak, dan memanggilnya dua kali dalam
  // satu proses memasang state global Dawn dua kali. Itu terlihat sebagai
  // worker vitest yang mati dengan "Worker exited unexpectedly" tanpa
  // menyebut test mana pun -- vitest mendaur ulang proses worker antar berkas
  // test, jadi berkas kedua yang mengakuisisi device di worker yang sama
  // memanggil `create()` untuk kedua kalinya. Memoisasi ini membuat kedua sisi
  // (browser dan Node) punya semantik yang sama: satu instance GPU per proses.
  dawnGpu ??= importDawn().then((mod) => (mod as { create(flags: string[]): GPU }).create([]));
  return dawnGpu;
}

/**
 * Minta device dari `adapter` dengan `requiredLimits` tertentu, membungkus
 * penolakan asli adapter (mis. DOMException `OperationError` saat limit
 * tak terpenuhi) menjadi WebGPUDeviceRequestError yang menyebutkan alasan
 * aslinya, bukan meneruskan galat mentah WebGPU ke pemanggil.
 *
 * Diekstrak dari acquireDevice() agar jalur kegagalan ini bisa diuji secara
 * langsung — dengan limit yang sengaja mustahil dipenuhi — tanpa mengubah
 * limit yang benar-benar diminta pada jalur produksi.
 */
export async function requestDeviceWithLimits(
  adapter: GPUAdapter,
  requiredLimits: Record<string, number>,
): Promise<GPUDevice> {
  try {
    return await adapter.requestDevice({ requiredLimits });
  } catch (cause) {
    throw new WebGPUDeviceRequestError(
      `permintaan ${JSON.stringify(requiredLimits)} ditolak (${String(cause)})`,
    );
  }
}

export async function acquireDevice(): Promise<EngineDevice> {
  let gpu: GPU;
  try {
    gpu = await getNavigatorGpu();
  } catch (cause) {
    throw new WebGPUUnavailableError(`navigator.gpu tidak ada (${String(cause)})`);
  }

  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new WebGPUUnavailableError('tidak ada adapter yang cocok');

  // Kualitas di atas performa: minta ukuran binding sebesar yang diizinkan
  // adapter, agar render full-frame tidak perlu di-tile lebih awal dari
  // yang diperlukan. Jumlah storage buffer sengaja TIDAK dinaikkan — arena
  // dirancang untuk muat di batas terjamin 8 (adapter ini sendiri hanya
  // menawarkan 16, dan kernel terbesar upstream, SpektraPrintScan, mengikat
  // 30 — jadi packing arena adalah KEWAJIBAN, bukan sekadar kehati-hatian).
  //
  // Limit workgroup compute (maxComputeWorkgroupSizeX/Y/Z,
  // maxComputeInvocationsPerWorkgroup) SENGAJA dibiarkan pada default
  // WebGPU (256/256/64/256) dan TIDAK diminta naik: kesepuluh shader hulu
  // upstream memakai tepat 256 invokasi per workgroup (32×8×1, atau
  // 256×1×1 untuk Copy/FormatConvert) — pas di batas minimum yang dijamin
  // spesifikasi. Menaikkannya tidak dibutuhkan dan hanya akan membuat
  // engine ini bergantung pada perangkat yang lebih murah hati.
  const device = await requestDeviceWithLimits(adapter, {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
  });

  assertGuaranteedStorageBufferLimit(device.limits);

  device.lost.then((info) => {
    console.error(`Device WebGPU hilang: ${info.reason} — ${info.message}`);
  });

  return {
    device,
    limits: device.limits,
    maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
  };
}
