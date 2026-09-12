import { describe, it, expect } from 'vitest';
import {
  acquireDevice,
  assertGuaranteedStorageBufferLimit,
  getNavigatorGpu,
  requestDeviceWithLimits,
  WebGPUDeviceRequestError,
  WebGPUUnavailableError,
} from '../src/engine/device';

describe('acquireDevice', () => {
  it('memperoleh device dengan limit yang dilaporkan', async () => {
    const engine = await acquireDevice();
    expect(engine.device).toBeDefined();
    expect(engine.maxStorageBufferBindingSize).toBeGreaterThan(0);
  });

  it('menyediakan minimal 8 storage buffer per stage', async () => {
    const engine = await acquireDevice();
    expect(engine.limits.maxStorageBuffersPerShaderStage).toBeGreaterThanOrEqual(8);
  });
});

describe('requestDeviceWithLimits (jalur kegagalan)', () => {
  // Panggilan terpisah dari acquireDevice(): jalur produksi tidak diubah
  // atau dilonggarkan sedikit pun oleh test ini. Adapter yang sama dipakai,
  // tetapi limit yang diminta di sini sengaja mustahil dipenuhi adapter apa
  // pun, untuk memaksa penolakan asli WebGPU dan memeriksa bahwa penolakan
  // itu benar-benar dibungkus, bukan diteruskan mentah.
  it('membungkus penolakan adapter menjadi WebGPUDeviceRequestError, bukan galat mentah', async () => {
    const gpu = await getNavigatorGpu();
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    expect(adapter).toBeTruthy();
    if (!adapter) return;

    const impossibleLimit = adapter.limits.maxBufferSize * 2;

    await expect(
      requestDeviceWithLimits(adapter, { maxBufferSize: impossibleLimit }),
    ).rejects.toBeInstanceOf(WebGPUDeviceRequestError);
  });

  it('menyertakan alasan asli penolakan pada pesan, tidak menelannya', async () => {
    const gpu = await getNavigatorGpu();
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    expect(adapter).toBeTruthy();
    if (!adapter) return;

    const impossibleLimit = adapter.limits.maxBufferSize * 2;

    try {
      await requestDeviceWithLimits(adapter, { maxBufferSize: impossibleLimit });
      expect.unreachable('requestDeviceWithLimits seharusnya melempar untuk limit mustahil');
    } catch (err) {
      expect(err).toBeInstanceOf(WebGPUDeviceRequestError);
      const message = (err as Error).message;
      // Alasan asli WebGPU (nama limit + nilai yang diminta) harus terlihat
      // di pesan, bukan hanya "ditolak" tanpa konteks.
      expect(message).toContain(String(impossibleLimit));
      expect(message).toContain('maxBufferSize');
    }
  });
});

describe('assertGuaranteedStorageBufferLimit', () => {
  // Objek limit tiruan, tanpa menyentuh device WebGPU sungguhan — sama
  // seperti pola requestDeviceWithLimits di atas: memaksa jalur kegagalan
  // langsung, tanpa mengubah apa pun yang acquireDevice() sungguhan minta.
  it('melempar WebGPUUnavailableError bila device melaporkan di bawah 8', () => {
    expect(() =>
      assertGuaranteedStorageBufferLimit({ maxStorageBuffersPerShaderStage: 4 }),
    ).toThrow(WebGPUUnavailableError);
  });

  it('menyertakan angka yang dilaporkan pada pesan, tidak menelannya', () => {
    try {
      assertGuaranteedStorageBufferLimit({ maxStorageBuffersPerShaderStage: 4 });
      expect.unreachable('assertGuaranteedStorageBufferLimit seharusnya melempar untuk 4');
    } catch (err) {
      expect(err).toBeInstanceOf(WebGPUUnavailableError);
      const message = (err as Error).message;
      expect(message).toContain('4');
      expect(message).toContain('8');
    }
  });

  it('tidak melempar bila device melaporkan tepat 8 atau lebih', () => {
    expect(() =>
      assertGuaranteedStorageBufferLimit({ maxStorageBuffersPerShaderStage: 8 }),
    ).not.toThrow();
    expect(() =>
      assertGuaranteedStorageBufferLimit({ maxStorageBuffersPerShaderStage: 16 }),
    ).not.toThrow();
  });
});
