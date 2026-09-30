import { CORE_PARAMS_WGSL } from '../params';
import { Tap } from '../taps';
import type { Stage, StageContext } from '../graph';
import type { Arenas } from '../arena';
import { gpuBufferUsage } from '../webgpuGlobals';
import { GRAIN_SPATIAL_RADIUS_PX } from '../tiling';
import source from '../../shaders/grain.wgsl?raw';

/**
 * Tahap Grain (Task 16): transliterasi `model/grain.py::apply_grain`
 * (Python), BUKAN `SpektraGrain.comp` (1.183 baris GLSL) -- lih. blok
 * komentar modul `grain.wgsl` untuk rasional lengkap dan
 * `.superpowers/sdd/2026-09-11-dichroic-phase1-engine/task-16-report.md`
 * untuk pembuktian numeriknya. Menutup gerbang STATISTIK (bukan per-piksel)
 * pada `cmy_film`, keluarga fixture `_stochastic`.
 *
 * Posisi rantai: `materializeActiveRegion → filmExposure → halation →
 * curveDevelop → dir → grain` (family `measured`). `createHalationStage`
 * WAJIB ADA di depan `curveDevelop` -- `defaultCoreParams` family
 * `'measured'` memaksa `slot0=1` pada `filmExposure.wgsl` (simpan RAW
 * LINEAR, bukan log10; Halation men-`log10`-kan sebagai dispatch
 * TERAKHIRnya, persis `FilmingStage.expose()` Python). Melewatkan halation
 * membuat `curveDevelop` membaca RAW LINEAR seakan-akan log -- dibuktikan
 * lewat GPU sungguhan, BUKAN cuma teori: mean hijau `gray_ramp` melonjak
 * ~2x sebelum perbaikan ini (lih. `grain.test.ts` untuk rincian).
 *
 * Rantai ini TETAP TIDAK menyertakan spasial DIR-coupler
 * (`dir.wgsl` hanya mengimplementasikan cabang non-spasial,
 * `dir_couplers.diffusion_size_um=20.0` default AKTIF untuk keluarga
 * `_stochastic` yang bukan `lut_mode`) -- residualnya terukur
 * (task-16-report.md) tetap di bawah ambang statistik untuk
 * gray_ramp/log_gray_ramp/color_patches_stochastic, tapi TIDAK untuk
 * hard_edge/impulse_highlight (dominan residual DIR-spasial, bukan grain)
 * -- karena itu test hanya memakai tiga kasus yang sama seperti
 * `curveDevelop.test.ts`.
 *
 * SEMBILAN COMPUTE PIPELINE dari SATU modul WGSL (`generateLayers`/
 * `blurLayersX`/`blurLayersY`/`microGenerate`/`microBlurX`/`microBlurY`/
 * `combine`/`blurX`/`blurY`) -- Task 16b naik dari tiga jadi sembilan untuk
 * mengimplementasikan `blur_particle` (blur per-sublapisan, sigma
 * per-kanal berbeda) dan `add_micro_structure` (clumping lognormal +
 * blur bersarang) yang DULU terbukti no-op pada fixture 64px, TIDAK LAGI
 * pada `grain_dense_patch` (lih. `grain.wgsl` untuk rasional lengkap dan
 * task-16b-report.md untuk pembuktian numerik). BUKAN satu pipeline dengan
 * operation-selector seperti halation.ts -- setiap entry point WGSL hanya
 * merujuk perannya sendiri, jadi `layout: 'auto'` Dawn menghasilkan bind
 * group layout BERBEDA per pipeline (hanya mencakup binding yang benar-
 * benar dipakai entry point itu), tanpa perlu buffer filler/junk untuk
 * menghindari "writable storage buffer binding aliasing" (lih. Hard
 * Constraints/task-14-report.md) -- setiap dispatch di sini punya himpunan
 * binding writable yang genuinely disjoint.
 *
 * DELAPAN peran scratch (sejak ekspor hemat memori: ditumpuk ke TIGA buffer,
 * lih. `encode`) lewat `ctx.scratch()` (`layerRaw`, `layerBlurX`,
 * `layerSummed`, `microRaw`, `microBlurX`, `microBlurred`, `preBlur`,
 * `blurX`) -- naik dari dua di Task 16 karena blur_particle butuh mem-blur
 * SETIAP (kanal,sublapisan) SENDIRI-SENDIRI (sigma berbeda per pasangan)
 * SEBELUM dijumlahkan lintas sublapisan (blur dan penjumlahan lintas kernel
 * berbeda TIDAK bisa dipertukarkan urutannya), dan micro-structure butuh
 * field clumping-nya sendiri. Brief Task 16 menyebut enam buffer
 * ("AuxPixelsA/B, MicroPixelsA/B, GrainLayerA/B") meniru kebutuhan
 * `SpektraGrain.comp` OFX -- delapan di sini bukan menyalin angka itu,
 * melainkan turunan independen dari struktur data Python (`layer_raw`
 * per-sublapisan PLUS clumping, bukan pasangan A/B ping-pong OFX).
 *
 * `pixel_size_um` dihitung PER-RUN dari `ctx.params.fullWidth/fullHeight`
 * (35mm/longEdge, KONSTANTA sama dengan halation.ts/diffusion.ts -- lih.
 * `FILM_FORMAT_MM` di sana) lewat buffer `frameFloats` kecil miliknya
 * sendiri, ditulis ulang tiap `encode()` -- BUKAN bagian arena `stock`
 * yang di-cache lintas kasus uji berbeda ukuran (lih. penjelasan panjang di
 * `halation.ts` untuk bahaya membakar nilai ini ke arena yang di-cache).
 *
 * MISMATCH FULL-BUFFER/AKTIF-SAJA, DIAUDIT (review seluruh-branch agenda #3,
 * `docs/superpowers/plans/2026-09-11-dichroic-phase1-engine.md`):
 * `generateLayers()`/`combine()` hanya menulis `layerRaw`/`preBlur` di dalam
 * sub-rektangel aktif (mengikuti pola `curveDevelop`/`dir`, PERSIS `generate()`
 * lama); `blurLayersX/Y`/`microGenerate`/`microBlurX/Y`/`blurX`/`blurY`
 * membaca/menulis LEWAT SELURUH lebar/tinggi buffer (untuk refleksi tepi
 * yang benar). Draf sebelumnya paragraf ini mengklaim ini "keterbatasan
 * tiling yang diketahui, tidak diselesaikan" -- SALAH DIAGNOSIS: diaudit
 * ulang dan DIUKUR (bukan dinalar) di `test/tiling.test.ts` ("Task 19b --
 * gerbang bit-identik pada skala apron produksi"), pada geometri yang
 * `remainingSpatialRadius`-nya (lih. `graph.ts::inflateActiveRect`) BENAR-
 * BENAR lebih kecil dari buffer tile (beda dari fixture gerbang lain di repo
 * ini, yang semuanya kekecilan sehingga rektangel aktif selalu terinflasi
 * balik jadi SELURUH buffer -- lih. komentar di test itu). Gerbang itu HIJAU:
 * `remainingSpatialRadius` yang menginflasi rektangel aktif tahap ini SELALU
 * >= `spatialRadiusPx` tahap ini sendiri (dijumlahkan SEBELUM radiusnya
 * dikurangkan), jadi rektangel yang DITULIS `generateLayers()`/`combine()`
 * selalu mencakup PALING SEDIKIT `center ± GRAIN_SPATIAL_RADIUS_PX` -- persis
 * yang `blurLayersX/Y`/dst. butuh baca untuk piksel di dalam `center`. Data
 * pool yang bocor dari tile sebelumnya (scratch TIDAK di-nol-kan, lih.
 * `StageContext.scratch`) selalu berada DI LUAR jendela itu. Kesimpulan
 * struktural, bukan cuma properti fixture kecil -- TIDAK diubah.
 */
export function createGrainStage(
  device: GPUDevice,
  arenas: Arenas,
  // Task 16b dulu menerima `filmFormatMm` di sini khusus untuk gerbang
  // `grain_dense_patch`; sejak Fase 2A.5 format film datang dari
  // `ctx.frame` (`RenderGraph.run(..., { frame })`), sama untuk semua tahap.
): Stage {
  const arenaConstants = arenas.stock.wgslConstants();
  const code = `${CORE_PARAMS_WGSL}\n\n${arenaConstants}\n\n${source}`;

  const module = device.createShaderModule({ label: 'grain', code });

  function pipeline(entryPoint: string): GPUComputePipeline {
    return device.createComputePipeline({
      label: `grain:${entryPoint}`,
      layout: 'auto',
      compute: { module, entryPoint },
    });
  }

  const generateLayersPipeline = pipeline('generateLayers');
  const blurLayersXPipeline = pipeline('blurLayersX');
  const blurLayersYPipeline = pipeline('blurLayersY');
  const microGeneratePipeline = pipeline('microGenerate');
  const microBlurXPipeline = pipeline('microBlurX');
  const microBlurYPipeline = pipeline('microBlurY');
  const combinePipeline = pipeline('combine');
  const blurXPipeline = pipeline('blurX');
  const blurYPipeline = pipeline('blurY');


  return {
    name: 'grain',
    writesTaps: [Tap.CMY_FILM],
    // Task 19b: port `grainRadius` hulu (`SpektraVulkanRenderer.cpp:5003-5004`,
    // `kVulkanGrainSpatialRadiusPx` -- guard hulu `productionGrainPath ||
    // grainSynthesisPath`; tahap ini HANYA mengimplementasikan varian itu,
    // lih. blok komentar modul: `blurX`/`blurY` SELALU jalan, tidak ada
    // varian "preview" tanpa blur di port ini).
    spatialRadiusPx: GRAIN_SPATIAL_RADIUS_PX,
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const { width, height } = ctx.params;
      const pixelBytes = width * height * 4 * Float32Array.BYTES_PER_ELEMENT;
      const layerBytes = width * height * 3 * 4 * Float32Array.BYTES_PER_ELEMENT;

      // Task 16b: `layerRaw`/`layerBlurX` menyimpan TIGA vec4 per piksel
      // (satu per sublapisan, lih. blok komentar modul grain.wgsl) --
      // `layerSummed`/`microRaw`/`microBlurXOut`/`microBlurred`/`preBlur`/
      // `blurXOut` tetap SATU vec4 per piksel seperti sebelumnya.
      // Delapan peran, TIGA buffer: umur tiap peran (dispatch yang menulis
      // sampai dispatch terakhir yang membaca) tidak bertumpuk dengan peran
      // lain di buffer yang sama, dan tidak ada dispatch yang mengikat satu
      // buffer dua kali. Urutan: generateLayers -> blurLayersX -> blurLayersY
      // -> microGenerate -> microBlurX -> microBlurY -> combine -> blurX -> blurY.
      //   A (3 vec4/px): layerRaw [1-2] -> layerSummed [3-7] -> blurXOut [8-9]
      //   B (3 vec4/px): layerBlurX [2-3] -> microRaw [4-5] -> microBlurred [6-7]
      //   C (1 vec4/px): microBlurX [5-6] -> preBlur [7-8]
      // 192 -> 112 byte/px (24 MP: 4,6 GB -> 2,7 GB).
      const layerRaw = ctx.scratch('grain:A', layerBytes);
      const layerBlurXBuf = ctx.scratch('grain:B', layerBytes);
      const layerSummed = layerRaw;
      const microRaw = layerBlurXBuf;
      const microBlurXBuf = ctx.scratch('grain:C', pixelBytes);
      const microBlurred = layerBlurXBuf;
      const preBlur = microBlurXBuf;
      const blurXOut = layerRaw;

      const longEdge = Math.max(ctx.params.fullWidth, ctx.params.fullHeight, 1);
      // Fase 2A.5: format film dari `ctx.frame` (dulu argumen `filmFormatMm`).
      const pixelSizeUm = (ctx.frame.filmFormatMm * 1000) / longEdge;

      // [pixel_size_um, grainSeed (Fase 2C), grainAmount (Fase 2C)] -- lih. `kFrame*` grain.wgsl.
      const frameFloatsBuffer = ctx.device.createBuffer({
        label: 'grain:frameFloats',
        size: 12,
        usage: gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(frameFloatsBuffer.getMappedRange()).set([
        pixelSizeUm,
        ctx.frame.grainSeed ?? 1,
        ctx.frame.grainAmount ?? 1,
      ]);
      frameFloatsBuffer.unmap();

      const activeWidth = ctx.params.activeWidth === 0 ? ctx.params.width : ctx.params.activeWidth;
      const activeHeight =
        ctx.params.activeHeight === 0 ? ctx.params.height : ctx.params.activeHeight;
      const groupsX = Math.ceil(activeWidth / 32);
      const groupsY = Math.ceil(activeHeight / 8);
      const fullGroupsX = Math.ceil(width / 32);
      const fullGroupsY = Math.ceil(height / 8);

      function dispatch(
        label: string,
        p: GPUComputePipeline,
        entries: GPUBindGroupEntry[],
        gx: number,
        gy: number,
      ): void {
        const bindGroup = ctx.device.createBindGroup({ layout: p.getBindGroupLayout(0), entries });
        const pass = encoder.beginComputePass({ label });
        pass.setPipeline(p);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(gx, gy, 1);
        pass.end();
      }

      // generateLayers: 0 src / 1 layerRaw / 2 params / 3 stock / 4 frameFloats
      dispatch(
        'grain:generateLayers',
        generateLayersPipeline,
        [
          { binding: 0, resource: { buffer: ctx.source } },
          { binding: 1, resource: { buffer: layerRaw } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 3, resource: { buffer: arenas.stock.buffer } },
          { binding: 4, resource: { buffer: frameFloatsBuffer } },
        ],
        groupsX,
        groupsY,
      );

      // blurLayersX: 1 layerRaw(read) / 5 layerBlurX(write) / 2 params / 3 stock / 4 frameFloats
      dispatch(
        'grain:blurLayersX',
        blurLayersXPipeline,
        [
          { binding: 1, resource: { buffer: layerRaw } },
          { binding: 5, resource: { buffer: layerBlurXBuf } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 3, resource: { buffer: arenas.stock.buffer } },
          { binding: 4, resource: { buffer: frameFloatsBuffer } },
        ],
        fullGroupsX,
        fullGroupsY,
      );

      // blurLayersY: 5 layerBlurX(read) / 6 layerSummed(write) / 2 params / 3 stock / 4 frameFloats
      dispatch(
        'grain:blurLayersY',
        blurLayersYPipeline,
        [
          { binding: 5, resource: { buffer: layerBlurXBuf } },
          { binding: 6, resource: { buffer: layerSummed } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 3, resource: { buffer: arenas.stock.buffer } },
          { binding: 4, resource: { buffer: frameFloatsBuffer } },
        ],
        fullGroupsX,
        fullGroupsY,
      );

      // microGenerate: 7 microRaw(write) / 2 params / 4 frameFloats
      dispatch(
        'grain:microGenerate',
        microGeneratePipeline,
        [
          { binding: 7, resource: { buffer: microRaw } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 4, resource: { buffer: frameFloatsBuffer } },
        ],
        fullGroupsX,
        fullGroupsY,
      );

      // microBlurX: 7 microRaw(read) / 8 microBlurXOut(write) / 2 params / 4 frameFloats
      dispatch(
        'grain:microBlurX',
        microBlurXPipeline,
        [
          { binding: 7, resource: { buffer: microRaw } },
          { binding: 8, resource: { buffer: microBlurXBuf } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 4, resource: { buffer: frameFloatsBuffer } },
        ],
        fullGroupsX,
        fullGroupsY,
      );

      // microBlurY: 8 microBlurXOut(read) / 9 microBlurred(write) / 2 params / 4 frameFloats
      dispatch(
        'grain:microBlurY',
        microBlurYPipeline,
        [
          { binding: 8, resource: { buffer: microBlurXBuf } },
          { binding: 9, resource: { buffer: microBlurred } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 4, resource: { buffer: frameFloatsBuffer } },
        ],
        fullGroupsX,
        fullGroupsY,
      );

      // combine: 6 layerSummed(read) / 9 microBlurred(read) / 10 preBlur(write) / 2 params
      dispatch(
        'grain:combine',
        combinePipeline,
        [
          { binding: 6, resource: { buffer: layerSummed } },
          { binding: 9, resource: { buffer: microBlurred } },
          { binding: 10, resource: { buffer: preBlur } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
        ],
        groupsX,
        groupsY,
      );

      // blurX (LAMA, tidak berubah): 10 preBlur(read) / 11 blurXOut(write) / 2 params
      dispatch(
        'grain:blurX',
        blurXPipeline,
        [
          { binding: 10, resource: { buffer: preBlur } },
          { binding: 11, resource: { buffer: blurXOut } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
        ],
        fullGroupsX,
        fullGroupsY,
      );

      // blurY: 11 blurXOut(read) / 12 dst(write) / 2 params, plus (Fase 2C,
      // `applyGrainControls`) 0 src = densitas sebelum grain / 4 frameFloats.
      dispatch(
        'grain:blurY',
        blurYPipeline,
        [
          { binding: 0, resource: { buffer: ctx.source } },
          { binding: 4, resource: { buffer: frameFloatsBuffer } },
          { binding: 11, resource: { buffer: blurXOut } },
          { binding: 12, resource: { buffer: ctx.dest } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
        ],
        fullGroupsX,
        fullGroupsY,
      );
    },
  };
}
