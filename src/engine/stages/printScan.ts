import { CORE_PARAMS_WGSL } from '../params';
import { Tap } from '../taps';
import type { Stage, StageContext } from '../graph';
import type { Arenas } from '../arena';
import source from '../../shaders/printScan.wgsl?raw';

/**
 * Tahap PrintScan (Task 17): dua entry point WGSL (`expose`/`develop`, satu
 * modul `printScan.wgsl`), dua tahap TS -- `createPrintExposureStage`
 * menulis `log_e_print`, `createPrintDevelopStage` menulis `cmy_print`. Lih.
 * komentar panjang di `printScan.wgsl` untuk alasan pemisahan dan
 * cakupan (`_lut` family, `slot0` sebagai penanda ada/tidaknya
 * Diffusion(print) di chain -- persis pola `filmExposure.wgsl`/`diffusion.ts`
 * di sisi kamera).
 *
 * `arenas.stock` di sini HARUS stock yang SAMA dengan yang dipakai
 * `filmExposureStage`/`curveDevelopStage`/`dirStage` di chain yang sama
 * (FILM, mis. `kodak_portra_400`) -- Task 17 menambahkan `channelDensity`/
 * `baseDensity` ke arena `stock` FILM itu (`src/host/spectral.ts`), bukan
 * arena baru. `arenas.dynamic` HARUS sudah diaugmentasi lewat
 * `addPrintScanDynamicData` (dipanggil `precomputeArenaData(bundle,
 * filmStockId, { printStockId, enlargerFilters })`, lih. dokumentasi
 * `PrintScanArenaOptions` di `src/host/spectral.ts`) -- kedua tahap di sini
 * TIDAK memvalidasi itu (arena yang salah bentuk gagal di WGSL dengan
 * offset yang salah, bukan galat TypeScript yang jelas -- sama seperti
 * setiap tahap lain sejak Task 11).
 */
export function createPrintExposureStage(device: GPUDevice, arenas: Arenas): Stage {
  const arenaConstants = `${arenas.stock.wgslConstants()}\n\n${arenas.dynamic.wgslConstants()}`;

  const module = device.createShaderModule({
    label: 'printScan:expose',
    code: `${CORE_PARAMS_WGSL}\n\n${arenaConstants}\n\n${source}`,
  });

  const pipeline = device.createComputePipeline({
    label: 'printScan:expose',
    layout: 'auto',
    compute: { module, entryPoint: 'expose' },
  });

  return {
    name: 'printScan:expose',
    writesTaps: [Tap.LOG_E_PRINT],
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const bindGroup = ctx.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ctx.source } },
          { binding: 1, resource: { buffer: ctx.dest } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 3, resource: { buffer: arenas.stock.buffer } },
          { binding: 4, resource: { buffer: arenas.dynamic.buffer } },
        ],
      });

      const activeWidth = ctx.params.activeWidth === 0 ? ctx.params.width : ctx.params.activeWidth;
      const activeHeight =
        ctx.params.activeHeight === 0 ? ctx.params.height : ctx.params.activeHeight;

      const pass = encoder.beginComputePass({ label: 'printScan:expose' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(activeWidth / 32), Math.ceil(activeHeight / 8), 1);
      pass.end();
    },
  };
}

export function createPrintDevelopStage(device: GPUDevice, arenas: Arenas): Stage {
  // `arenas.stock.wgslConstants()` HARUS ikut disertakan meski `develop`
  // sendiri tidak membaca binding `filmStockArena` (3): satu modul WGSL
  // (`printScan.wgsl`) dipakai KEDUA pipeline, dan `computeDensitySpectral`
  // (dipakai HANYA oleh `expose`) tetap top-level function di modul yang
  // sama -- Dawn menggagalkan SELURUH `createShaderModule` kalau konstanta
  // `ARENA_CHANNELDENSITY_OFFSET`/`ARENA_BASEDENSITY_OFFSET` yang dipakainya
  // tidak resolve, terlepas dari entry point mana yang akan dipilih
  // `createComputePipeline`. Ini named WGSL `const` (nilai integer
  // tersubstitusi teks), BUKAN bind group entry -- menyertakannya di sini
  // tidak menambah binding baru sama sekali (bind group `develop` tetap
  // hanya 0/1/2/4, lih. komentar berkas `printScan.wgsl`).
  const arenaConstants = `${arenas.stock.wgslConstants()}\n\n${arenas.dynamic.wgslConstants()}`;

  const module = device.createShaderModule({
    label: 'printScan:develop',
    code: `${CORE_PARAMS_WGSL}\n\n${arenaConstants}\n\n${source}`,
  });

  const pipeline = device.createComputePipeline({
    label: 'printScan:develop',
    layout: 'auto',
    compute: { module, entryPoint: 'develop' },
  });

  return {
    name: 'printScan:develop',
    writesTaps: [Tap.CMY_PRINT],
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const bindGroup = ctx.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ctx.source } },
          { binding: 1, resource: { buffer: ctx.dest } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 4, resource: { buffer: arenas.dynamic.buffer } },
        ],
      });

      const activeWidth = ctx.params.activeWidth === 0 ? ctx.params.width : ctx.params.activeWidth;
      const activeHeight =
        ctx.params.activeHeight === 0 ? ctx.params.height : ctx.params.activeHeight;

      const pass = encoder.beginComputePass({ label: 'printScan:develop' });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(activeWidth / 32), Math.ceil(activeHeight / 8), 1);
      pass.end();
    },
  };
}
