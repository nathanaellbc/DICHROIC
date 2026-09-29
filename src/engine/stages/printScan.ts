import { CORE_PARAMS_WGSL, FLAG_COLOR_ADAPTATION_INPUT_COMPRESSION } from '../params';
import type { CoreParams } from '../params';
import { Tap } from '../taps';
import type { FrameParams, Stage, StageContext } from '../graph';
import type { Arenas } from '../arena';
import { gpuBufferUsage } from '../webgpuGlobals';
import { midgrayTablesFrom, printMidgrayFactor } from '../../host/printExposure';
import type { MidgrayTables } from '../../host/printExposure';
import { preflashRaw } from '../../host/preflash';
import type { PreflashTables } from '../../host/preflash';
import source from '../../shaders/printScan.wgsl?raw';

/**
 * Fase 2C: nilai `printFrame` (binding 5) untuk satu render -- faktor midgray
 * print dan `print_exposure`. Faktor bergantung pada `filmGamma` (push/pull),
 * EV kompensasi, dan saklar kompensasi; di-memo per kombinasi supaya render
 * ter-tile tidak menghitung ulang per tile.
 */
function printFrameValues(
  tables: MidgrayTables,
  srgbColorSpace: number,
  params: CoreParams,
  frame: Readonly<FrameParams>,
  memo: Map<string, number>,
): Float32Array {
  const inputCompression = (params.slot1 & FLAG_COLOR_ADAPTATION_INPUT_COMPRESSION) !== 0;
  const compensation = frame.printExposureCompensation ?? false;
  const ev = frame.exposureCompensationEv ?? 0;
  const key = `${params.filmGamma}|${inputCompression}|${compensation}|${ev}`;
  let factor = memo.get(key);
  if (factor === undefined) {
    factor = printMidgrayFactor(tables, {
      srgbColorSpace,
      inputCompression,
      gamma: params.filmGamma,
      compensation,
      exposureCompensationEv: ev,
    });
    memo.set(key, factor);
  }
  return Float32Array.of(factor, frame.printExposure ?? 1, 0, 0);
}

/** Fase 2D: vektor raw preflash (`printFrame.preflash`), di-memo per setelan. */
function preflashValues(tables: PreflashTables, frame: Readonly<FrameParams>, memo: Map<string, Float32Array>): Float32Array {
  const settings = {
    exposure: frame.preflashExposure ?? 0,
    mFilterShift: frame.preflashMFilterShift ?? 0,
    yFilterShift: frame.preflashYFilterShift ?? 0,
  };
  const key = `${settings.exposure}|${settings.mFilterShift}|${settings.yFilterShift}`;
  let values = memo.get(key);
  if (!values) {
    const raw = preflashRaw(tables, settings);
    values = Float32Array.of(raw[0], raw[1], raw[2], 0);
    memo.set(key, values);
  }
  return values;
}

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

  // Salinan host tabel midgray, SEKALI per tahap (arena tetap selama tahap hidup).
  let tables: MidgrayTables | undefined;
  const srgbColorSpace = arenas.dynamic.values('printMidgrayColorSpace')[0]!;
  const memo = new Map<string, number>();
  const preflashMemo = new Map<string, Float32Array>();
  const preflashTables: PreflashTables = {
    lightSource: arenas.dynamic.values('enlargerLightSource'),
    customEnlargerFilters: arenas.dynamic.values('customEnlargerFilters'),
    neutralCmy: arenas.dynamic.values('enlargerNeutralCmy'),
    baseDensity: arenas.stock.values('baseDensity'),
    printLinearSensitivity: arenas.dynamic.values('printLinearSensitivity'),
  };

  return {
    name: 'printScan:expose',
    writesTaps: [Tap.LOG_E_PRINT],
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      tables ??= midgrayTablesFrom(
        (arena, name) => arenas[arena].values(name),
        ctx.params.hanatosWidth,
        ctx.params.hanatosHeight,
      );
      const printFrame = ctx.device.createBuffer({
        label: 'printScan:printFrame',
        size: 32,
        usage: gpuBufferUsage.UNIFORM,
        mappedAtCreation: true,
      });
      const frameView = new Float32Array(printFrame.getMappedRange());
      frameView.set(printFrameValues(tables, srgbColorSpace, ctx.params, ctx.frame, memo), 0);
      frameView.set(preflashValues(preflashTables, ctx.frame, preflashMemo), 4);
      printFrame.unmap();

      const bindGroup = ctx.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ctx.source } },
          { binding: 1, resource: { buffer: ctx.dest } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 3, resource: { buffer: arenas.stock.buffer } },
          { binding: 4, resource: { buffer: arenas.dynamic.buffer } },
          { binding: 5, resource: { buffer: printFrame } },
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
