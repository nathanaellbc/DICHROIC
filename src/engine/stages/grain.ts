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
 * TIGA COMPUTE PIPELINE dari SATU modul WGSL (`generate`/`blurX`/`blurY`),
 * BUKAN satu pipeline dengan operation-selector seperti halation.ts --
 * setiap entry point WGSL hanya merujuk perannya sendiri, jadi
 * `layout: 'auto'` Dawn menghasilkan bind group layout BERBEDA per pipeline
 * (hanya mencakup binding yang benar-benar dipakai entry point itu), tanpa
 * perlu buffer filler/junk untuk menghindari "writable storage buffer
 * binding aliasing" (lih. Hard Constraints/task-14-report.md) -- setiap
 * dispatch di sini punya himpunan binding writable yang genuinely disjoint.
 *
 * Dua scratch buffer (`grain:preBlur`, `grain:blurX`) diperoleh lewat
 * `ctx.scratch()`, BUKAN enam ("AuxPixelsA/B, MicroPixelsA/B, GrainLayerA/B")
 * yang disebut brief tugas -- brief itu mendeskripsikan kebutuhan
 * `SpektraGrain.comp` OFX (yang mengimplementasikan micro-structure DAN
 * blur per-lapisan sendiri, keduanya di-defer di sini, lih. `grain.wgsl`).
 * Python-lah oracle kita (Global Constraints), dan setelah micro-structure
 * + blur-per-lapisan dibuktikan no-op untuk fixture ini, hanya SATU buah
 * blur spasial akhir yang tersisa -- itu cuma butuh dua scratch (pra-blur,
 * pasca-blurX), TIDAK enam. Task mendatang yang mengaktifkan micro-
 * structure/blur-per-lapisan pada gambar resolusi produksi (lih. peringatan
 * pixel_size_um di `grain.wgsl`) mungkin butuh scratch tambahan saat itu.
 *
 * `pixel_size_um` dihitung PER-RUN dari `ctx.params.fullWidth/fullHeight`
 * (35mm/longEdge, KONSTANTA sama dengan halation.ts/diffusion.ts -- lih.
 * `FILM_FORMAT_MM` di sana) lewat buffer `frameFloats` kecil miliknya
 * sendiri, ditulis ulang tiap `encode()` -- BUKAN bagian arena `stock`
 * yang di-cache lintas kasus uji berbeda ukuran (lih. penjelasan panjang di
 * `halation.ts` untuk bahaya membakar nilai ini ke arena yang di-cache).
 *
 * KETERBATASAN TILING YANG DIKETAHUI, TIDAK DISELESAIKAN DI SINI: `generate()`
 * hanya menulis `preBlur` di dalam sub-rektangel aktif (mengikuti pola
 * `curveDevelop`/`dir`); `blurX`/`blurY` membaca `preBlur`/`blurXOut` LEWAT
 * SELURUH lebar/tinggi buffer (untuk refleksi tepi yang benar). Bila
 * `activeWidth/Height` suatu hari < `width/height` (Task 19, tiling), piksel
 * `preBlur` DI LUAR sub-rektangel aktif tidak pernah ditulis (scratch buffer
 * TIDAK di-nol-kan) dan `blurX` akan membaca sampah di dekat tepi
 * sub-rektangel itu. Fixture gerbang ini SELALU `activeWidth=activeHeight=0`
 * ("seluruh buffer"), jadi ini tidak termanifestasi di sini -- dicatat
 * eksplisit untuk siapa pun yang mengaktifkan tiling pada tahap ini nanti.
 */
export function createGrainStage(device: GPUDevice, arenas: Arenas): Stage {
  const arenaConstants = arenas.stock.wgslConstants();
  const code = `${CORE_PARAMS_WGSL}\n\n${arenaConstants}\n\n${source}`;

  const module = device.createShaderModule({ label: 'grain', code });

  const generatePipeline = device.createComputePipeline({
    label: 'grain:generate',
    layout: 'auto',
    compute: { module, entryPoint: 'generate' },
  });
  const blurXPipeline = device.createComputePipeline({
    label: 'grain:blurX',
    layout: 'auto',
    compute: { module, entryPoint: 'blurX' },
  });
  const blurYPipeline = device.createComputePipeline({
    label: 'grain:blurY',
    layout: 'auto',
    compute: { module, entryPoint: 'blurY' },
  });

  const FILM_FORMAT_MM = 35.0; // lih. halation.ts/diffusion.ts -- konstanta yang sama.

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

      const preBlur = ctx.scratch('grain:preBlur', pixelBytes);
      const blurXOut = ctx.scratch('grain:blurX', pixelBytes);

      const longEdge = Math.max(ctx.params.fullWidth, ctx.params.fullHeight, 1);
      const pixelSizeUm = (FILM_FORMAT_MM * 1000) / longEdge;

      const frameFloatsBuffer = ctx.device.createBuffer({
        label: 'grain:frameFloats',
        size: 4,
        usage: gpuBufferUsage.STORAGE | gpuBufferUsage.COPY_DST,
        mappedAtCreation: true,
      });
      new Float32Array(frameFloatsBuffer.getMappedRange()).set([pixelSizeUm]);
      frameFloatsBuffer.unmap();

      const activeWidth = ctx.params.activeWidth === 0 ? ctx.params.width : ctx.params.activeWidth;
      const activeHeight =
        ctx.params.activeHeight === 0 ? ctx.params.height : ctx.params.activeHeight;
      const groupsX = Math.ceil(activeWidth / 32);
      const groupsY = Math.ceil(activeHeight / 8);
      const fullGroupsX = Math.ceil(width / 32);
      const fullGroupsY = Math.ceil(height / 8);

      const generateBindGroup = ctx.device.createBindGroup({
        layout: generatePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: ctx.source } },
          { binding: 1, resource: { buffer: preBlur } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 3, resource: { buffer: arenas.stock.buffer } },
          { binding: 4, resource: { buffer: frameFloatsBuffer } },
        ],
      });
      const generatePass = encoder.beginComputePass({ label: 'grain:generate' });
      generatePass.setPipeline(generatePipeline);
      generatePass.setBindGroup(0, generateBindGroup);
      generatePass.dispatchWorkgroups(groupsX, groupsY, 1);
      generatePass.end();

      const blurXBindGroup = ctx.device.createBindGroup({
        layout: blurXPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 1, resource: { buffer: preBlur } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 5, resource: { buffer: blurXOut } },
        ],
      });
      const blurXPass = encoder.beginComputePass({ label: 'grain:blurX' });
      blurXPass.setPipeline(blurXPipeline);
      blurXPass.setBindGroup(0, blurXBindGroup);
      blurXPass.dispatchWorkgroups(fullGroupsX, fullGroupsY, 1);
      blurXPass.end();

      const blurYBindGroup = ctx.device.createBindGroup({
        layout: blurYPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 5, resource: { buffer: blurXOut } },
          { binding: 2, resource: { buffer: ctx.paramsBuffer } },
          { binding: 6, resource: { buffer: ctx.dest } },
        ],
      });
      const blurYPass = encoder.beginComputePass({ label: 'grain:blurY' });
      blurYPass.setPipeline(blurYPipeline);
      blurYPass.setBindGroup(0, blurYBindGroup);
      blurYPass.dispatchWorkgroups(fullGroupsX, fullGroupsY, 1);
      blurYPass.end();
    },
  };
}
