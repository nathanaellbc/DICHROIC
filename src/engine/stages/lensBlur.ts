import { Tap } from '../taps';
import type { Stage, StageContext } from '../graph';
import { gpuBufferUsage, gpuTextureUsage } from '../webgpuGlobals';
import type { DepthMap, LensFrame } from '../../host/lens';
import source from '../../shaders/lensBlur.wgsl?raw';

/**
 * Tahap lens blur (ekstensi DICHROIC, di luar spektrafilm): defocus sintetis
 * dari peta kedalaman, pada raw linear film setelah `filmExposure` dan
 * sebelum difusi kamera/halation (urutan `camera.lens_blur_um` Python). Lih.
 * `lensBlur.wgsl` untuk algoritmenya dan `host/lens.ts` untuk thin-lens-nya.
 *
 * Hanya dibangun `buildChain` bila aktif (`ChainSpec.lensBlur`), jadi rantai
 * yang digerbangi Python tidak pernah memuatnya. Frame harus utuh (tidak
 * di-tile): jangkauan cakram sampai 10 % sisi panjang; `Session` menjaga
 * ukuran render agar muat satu binding.
 */

/** Sisi tile untuk jangkauan foreground (px grid). */
export const DOF_TILE = 16;
/** Sisi panjang grid gather tidak pernah melebihi ini: blur itu frekuensi rendah. */
export const DOF_MAX_EDGE = 1536;
const MAX_REACH_TILES = 8;
const UNIFORM_BYTES = 80;

/**
 * Skala grid gather: pangkat dua, paling besar setengah resolusi, dan sisi
 * panjang grid tidak pernah melebihi `DOF_MAX_EDGE` -- sama dengan defocus
 * EMULSION (`2^-k`, `k = max(1, ceil(log2(sisi / 1536)))`), jadi pratinjau dan
 * ekspor besar mengumpulkan di grid berskala sama dan tampilan blurnya sama.
 */
export function lensGridScale(width: number, height: number): number {
  const k = Math.max(1, Math.ceil(Math.log2(Math.max(width, height, 1) / DOF_MAX_EDGE)));
  return 2 ** -k;
}

/** Ukuran grid gather untuk render `width x height`. */
export function lensGridSize(width: number, height: number): { gw: number; gh: number } {
  const scale = lensGridScale(width, height);
  return { gw: Math.max(1, Math.round(width * scale)), gh: Math.max(1, Math.round(height * scale)) };
}

interface Targets {
  key: string;
  grid: GPUTexture;
  far: GPUTexture;
  near: GPUTexture;
  mips: number;
}

const ENTRY_POINTS = ['prep', 'mip', 'tile', 'dilate', 'far', 'near', 'combine'] as const;
type EntryPoint = (typeof ENTRY_POINTS)[number];

export function createLensBlurStage(device: GPUDevice): Stage {
  const module = device.createShaderModule({ label: 'lensBlur', code: source });
  const pipelines = new Map<EntryPoint, GPUComputePipeline>();
  for (const entryPoint of ENTRY_POINTS) {
    pipelines.set(
      entryPoint,
      device.createComputePipeline({ label: `lensBlur:${entryPoint}`, layout: 'auto', compute: { module, entryPoint } }),
    );
  }
  const sampler = device.createSampler({
    label: 'lensBlur:sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  let targets: Targets | undefined;
  // Satu uniform per tahap, ditulis ulang tiap encode (dulu satu buffer baru
  // per render yang tidak pernah dihancurkan).
  const uniform = device.createBuffer({
    label: 'lensBlur:uniform',
    size: UNIFORM_BYTES,
    usage: gpuBufferUsage.UNIFORM | gpuBufferUsage.COPY_DST,
  });
  let depthCache: { map: DepthMap; buffer: GPUBuffer } | undefined;

  function targetsFor(gw: number, gh: number): Targets {
    const key = `${gw}x${gh}`;
    if (targets?.key === key) return targets;
    targets?.grid.destroy();
    targets?.far.destroy();
    targets?.near.destroy();
    // Rantai mip penuh (seperti `generateMipmap` EMULSION): sampel gather yang
    // jarang membaca level selebar jaraknya, sampai cakram terbesar.
    const mips = Math.floor(Math.log2(Math.max(gw, gh))) + 1;
    const usage = gpuTextureUsage.TEXTURE_BINDING | gpuTextureUsage.STORAGE_BINDING;
    const texture = (label: string, mipLevelCount = 1) =>
      device.createTexture({ label: `lensBlur:${label}`, size: [gw, gh], format: 'rgba16float', usage, mipLevelCount });
    targets = { key, grid: texture('grid', mips), far: texture('far'), near: texture('near'), mips };
    return targets;
  }

  function depthBuffer(map: DepthMap): GPUBuffer {
    if (depthCache?.map === map) return depthCache.buffer;
    depthCache?.buffer.destroy();
    const buffer = device.createBuffer({
      label: 'lensBlur:depth',
      size: Math.max(map.data.byteLength, 16),
      usage: gpuBufferUsage.STORAGE,
      mappedAtCreation: true,
    });
    new Float32Array(buffer.getMappedRange()).set(map.data);
    buffer.unmap();
    depthCache = { map, buffer };
    return buffer;
  }

  return {
    name: 'lensBlur',
    writesTaps: [Tap.LOG_E_FILM],
    spatialRadiusPx: 0,
    encode(encoder: GPUCommandEncoder, ctx: StageContext): void {
      const { width, height, fullWidth, fullHeight } = ctx.params;
      if (width !== fullWidth || height !== fullHeight || ctx.params.activeWidth !== 0) {
        throw new Error('lensBlur: defocus butuh frame utuh (tidak di-tile).');
      }
      const lens: LensFrame | undefined = ctx.frame.lens;
      if (!lens) throw new Error('lensBlur: FrameParams tidak membawa setelan lensa.');
      const { gw, gh } = lensGridSize(width, height);
      const t = targetsFor(gw, gh);
      const gridScale = gw / width;
      const tilesX = Math.ceil(gw / DOF_TILE);
      const tilesY = Math.ceil(gh / DOF_TILE);
      const maxRadiusGrid = lens.maxCocPx * 0.5 * gridScale;
      const reach = Math.min(MAX_REACH_TILES, Math.ceil(maxRadiusGrid / DOF_TILE));

      const range = new ArrayBuffer(UNIFORM_BYTES);
      const u = new Uint32Array(range);
      const f = new Float32Array(range);
      u.set([width, height, gw, gh, lens.depth.width, lens.depth.height, tilesX, tilesY], 0);
      f.set([lens.focusDisparity, lens.cocScalePx, lens.maxCocPx, lens.nearDisparity, lens.foreground, gridScale, lens.bladeCurvature, lens.catEye], 8);
      const diag = Math.hypot(width, height);
      f.set([width / diag, height / diag], 16);
      u.set([lens.blades, reach], 18);
      device.queue.writeBuffer(uniform, 0, range);

      const depth = depthBuffer(lens.depth);
      const tileBytes = Math.max(tilesX * tilesY * 8, 16);
      const tiles = ctx.scratch('lensBlur:tiles', tileBytes);
      const dilated = ctx.scratch('lensBlur:dilated', tileBytes);
      const gridLevel = (level: number) => t.grid.createView({ baseMipLevel: level, mipLevelCount: 1 });
      const gridAll = t.grid.createView();

      const run = (entry: EntryPoint, entries: Record<number, GPUBindingResource>, x: number, y: number) => {
        const pipeline = pipelines.get(entry)!;
        const bindGroup = device.createBindGroup({
          label: `lensBlur:${entry}`,
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            // `mip` tidak membaca uniform; layout 'auto' hanya memuat binding yang dipakai.
            ...(entry === 'mip' ? [] : [{ binding: 0, resource: { buffer: uniform } }]),
            ...Object.entries(entries).map(([binding, resource]) => ({ binding: Number(binding), resource })),
          ],
        });
        const pass = encoder.beginComputePass({ label: `lensBlur:${entry}` });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(x / 8), Math.ceil(y / 8), 1);
        pass.end();
      };

      run('prep', { 1: { buffer: ctx.source }, 2: { buffer: depth }, 3: gridLevel(0) }, gw, gh);
      for (let level = 1; level < t.mips; level += 1) {
        const w = Math.max(1, gw >> level);
        const h = Math.max(1, gh >> level);
        run('mip', { 4: gridLevel(level - 1), 5: gridLevel(level) }, w, h);
      }
      run('tile', { 6: gridAll, 7: { buffer: tiles } }, tilesX, tilesY);
      run('dilate', { 8: { buffer: tiles }, 9: { buffer: dilated } }, tilesX, tilesY);
      run('far', { 6: gridAll, 10: sampler, 11: t.far.createView() }, gw, gh);
      run('near', { 6: gridAll, 10: sampler, 12: { buffer: dilated }, 13: t.near.createView() }, gw, gh);
      run(
        'combine',
        { 1: { buffer: ctx.source }, 2: { buffer: depth }, 10: sampler, 14: t.far.createView(), 15: t.near.createView(), 16: { buffer: ctx.dest } },
        width,
        height,
      );
    },
  };
}
