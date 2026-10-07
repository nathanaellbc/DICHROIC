import { createAssetBundle, expandF16 } from '../profiles/load';
import type { AssetBundle, Manifest } from '../profiles/load';
import { parsePrintCube, PRINT_LUTS, type PrintCube, type PrintLutId } from '../profiles/printLuts';
import { buildRenderPlan } from '../params/plan';
import type { RenderPlan } from '../params/plan';
import { BASELINE_RENDER_PARAMS, type RenderParams } from '../params/renderParams';
import { precomputeArenaData, uploadArenas } from '../host/spectral';
import type { ArenaPlan } from '../host/spectral';
import type { DepthMap } from '../host/lens';
import type { Arenas } from '../engine/arena';
import { buildChain } from '../engine/chain';
import { RenderGraph, ScratchPool, type TileSource } from '../engine/graph';
import type { TileSpec } from '../engine/tiling';
import { Tap, type TapName } from '../engine/taps';
import { GROUPS, DIFFUSION_FAMILIES, FILM_FORMATS } from '../ui/model/tools';
import { FILM_SECTIONS, PAPER_SECTIONS } from '../ui/model/stocks';
import { NativeGpuDevice, type NativeGpuHost } from './gpuDevice';

export interface NativeRenderHost extends NativeGpuHost {
  readAsset(name: string): ArrayBuffer;
  readText(name: string): string;
  /** Fill reused float tile storage directly from the native decoded source. */
  sourceTile(tile: TileSpec, output: Float32Array): void;
  /** Write only the tile core into the native output image/encoder. */
  outputTile(tile: TileSpec, rgb: Float32Array): void;
  progress(done: number, total: number): void;
}

export function nativeAssets(host: Pick<NativeRenderHost, 'readAsset' | 'readText'>): AssetBundle {
  return createAssetBundle(JSON.parse(host.readText('data/manifest.json')) as Manifest,
    new Float32Array(host.readAsset('data/stocks.f32')),
    expandF16(new Uint16Array(host.readAsset('data/hanatos.f16'))),
    new Float32Array(host.readAsset('data/static.f32')));
}

/** The native UI and canonical graph share one parameter/catalog definition. */
export function nativeCatalog(bundle: AssetBundle): string {
  return JSON.stringify({
    baseline: { ...BASELINE_RENDER_PARAMS, inputColorSpace: 'sRGB', inputCctfDecoding: true, autoExposure: false },
    groups: GROUPS, filmFormats: FILM_FORMATS, diffusionFamilies: DIFFUSION_FAMILIES,
    filmSections: FILM_SECTIONS, paperSections: PAPER_SECTIONS,
    printLuts: Object.entries(PRINT_LUTS).map(([id, lut]) => ({ id, ...lut })),
    inputColorSpaces: bundle.manifest.colorSpaces.labels,
    outputColorSpaces: Object.keys(bundle.manifest.outputColorSpaces),
  });
}

export class NativeRenderer {
  private readonly native: NativeGpuDevice;
  private readonly pool: ScratchPool;
  private arenas?: Arenas;
  private arenaKey?: string;
  private graph?: RenderGraph;
  private chainKey?: string;
  private depth?: DepthMap;
  private readonly cubes = new Map<PrintLutId, PrintCube>();
  private disposed = false;

  constructor(private readonly host: NativeRenderHost, private readonly bundle: AssetBundle,
    private readonly arenaProvider: (plan: RenderPlan) => ArenaPlan = plan => precomputeArenaData(bundle, plan.arenaInputs.stockId, plan.arenaInputs.printScan)) {
    this.native = new NativeGpuDevice(host);
    this.pool = new ScratchPool(this.native.asGpuDevice());
  }

  setDepth(depth: DepthMap | undefined): void { this.depth = depth; }

  private prepare(params: RenderParams, width: number, height: number, measure: Float32Array, measureWidth: number, measureHeight: number): RenderPlan {
    if (this.disposed) throw new Error('Native renderer is closed.');
    const plan = buildRenderPlan(params, this.bundle, { width, height,
      rgba: measure, measure: { rgba: measure, width: measureWidth, height: measureHeight } }, 'image',
    this.depth ? { depth: this.depth } : {});
    if (this.arenaKey !== plan.arenaKey) {
      this.graph?.dispose(); this.graph = undefined; this.chainKey = undefined;
      if (this.arenas) for (const arena of Object.values(this.arenas)) arena.destroy();
      this.arenas = undefined; this.arenaKey = undefined;
      this.arenas = uploadArenas(this.native.asGpuDevice(), this.arenaProvider(plan));
      this.arenaKey = plan.arenaKey;
    }
    const chainKey = JSON.stringify(plan.chain);
    if (!this.graph || this.chainKey !== chainKey) {
      this.graph?.dispose();
      const cube = plan.chain.printLut ? this.cube(plan.chain.printLut) : undefined;
      const device = this.native.asGpuDevice();
      this.graph = new RenderGraph({ device, limits: device.limits,
        maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize }, this.pool);
      for (const stage of buildChain(device, this.arenas!, plan.chain, cube)) this.graph.addStage(stage);
      this.chainKey = chainKey;
    }
    return plan;
  }

  private cube(id: PrintLutId): PrintCube {
    let cube = this.cubes.get(id);
    if (!cube) {
      cube = parsePrintCube(this.host.readText(`luts/${PRINT_LUTS[id].file}`), PRINT_LUTS[id].size);
      this.cubes.set(id, cube);
    }
    return cube;
  }

  async preview(params: RenderParams, rgba: Float32Array, width: number, height: number, collect: TapName = Tap.RGB_OUT): Promise<Float32Array> {
    const plan = this.prepare(params, width, height, rgba, width, height);
    // Preview is already ImageIO-downsampled. Lens requires a whole frame;
    // other stages use the canonical overlap if this binding needs tiling.
    return this.graph!.run(rgba, plan.core, collect, {
      maxBufferBytes: Math.min(this.native.limits.maxStorageBufferBindingSize, 32 * 1024 * 1024),
      overlap: plan.overlap, frame: plan.frame, output: 'rgb',
    });
  }

  async export(params: RenderParams, width: number, height: number, measure: Float32Array, measureWidth: number, measureHeight: number): Promise<void> {
    const plan = this.prepare(params, width, height, measure, measureWidth, measureHeight);
    const source: TileSource = (tile, into) => {
      const pixels = into.subarray(0, tile.tileWidth * tile.tileHeight * 4);
      this.host.sourceTile(tile, pixels);
      return pixels;
    };
    try {
      await this.graph!.runToTiles(source, plan.core, Tap.RGB_OUT,
        (rgb, tile) => this.host.outputTile(tile, rgb), {
          maxBufferBytes: Math.min(this.native.limits.maxStorageBufferBindingSize, 32 * 1024 * 1024),
          memoryBudget: 192 * 1024 * 1024, overlap: plan.overlap, exportOverlap: plan.exportOverlap,
          frame: plan.frame, wholeFrame: plan.chain.lensBlur === true || !!plan.chain.cameraDiffusion || !!plan.chain.printDiffusion,
          onProgress: (done, total) => this.host.progress(done, total),
        });
    } finally {
      this.graph!.releaseFrameResources();
      this.pool.release();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.graph?.dispose();
    if (this.arenas) for (const arena of Object.values(this.arenas)) arena.destroy();
    this.pool.release();
    this.native.releasePipelines();
    this.cubes.clear();
    this.disposed = true;
  }
}
