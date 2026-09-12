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

export interface EngineDevice {
  device: GPUDevice;
  limits: GPUSupportedLimits;
  maxStorageBufferBindingSize: number;
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
async function getNavigatorGpu(): Promise<GPU> {
  if (typeof navigator !== 'undefined' && navigator.gpu) return navigator.gpu;
  const mod = (await import('webgpu')) as { create(flags: string[]): GPU };
  return mod.create([]);
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
  // dirancang untuk muat di batas terjamin 8.
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });

  if (device.limits.maxStorageBuffersPerShaderStage < 8) {
    console.error(
      `Peringatan: device WebGPU ini hanya melaporkan ${device.limits.maxStorageBuffersPerShaderStage} ` +
        'storage buffer per shader stage, di bawah batas terjamin spesifikasi WebGPU (8). ' +
        'Arena buffer DICHROIC dirancang untuk 8 dan mungkin gagal mengikat semua tabel yang diperlukan.',
    );
  }

  device.lost.then((info) => {
    console.error(`Device WebGPU hilang: ${info.reason} — ${info.message}`);
  });

  return {
    device,
    limits: device.limits,
    maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
  };
}
