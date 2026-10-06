import type { StageContext } from './graph';

/**
 * Buffer kecil per render (uniform frame/params) milik satu `encode()`.
 * Lewat `ctx.transient` graf menghancurkannya setelah GPU selesai, alih-alih
 * menunggu GC: ekspor ber-tile memanggil `encode()` ratusan kali berturut-
 * turut tanpa jeda idle, dan di WebKit tiap buffer yang belum di-GC tetap
 * menahan alokasi Metal di proses GPU -- ribuan buffer menumpuk sampai tab
 * dimatikan. Tanpa `ctx.transient` (pemanggil lama) = `createBuffer` biasa.
 */
export function frameBuffer(ctx: Pick<StageContext, 'device' | 'transient'>, descriptor: GPUBufferDescriptor): GPUBuffer {
  return ctx.transient ? ctx.transient(descriptor) : ctx.device.createBuffer(descriptor);
}
