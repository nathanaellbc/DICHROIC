import { nativeAssets, nativeCatalog, NativeRenderer, type NativeRenderHost } from './renderer';
import type { RenderParams } from '../params/renderParams';
import type { DepthMap } from '../host/lens';
import { DIFFUSION_STRENGTH, GROUPS, choicePatch, decodeAllowed, findTool, formatStops, isModified, lensReadoutText, normalizePatch, positionPatch,
  resetPatch, sliderPosition, sliderRange, stepperAtEnd, stepperDisplay, stepperPatch, stockPatch, toolEnabled, valueText, visibleTools } from '../ui/model/tools';
import type { Tool } from '../ui/model/tools';
import { BASELINE_RENDER_PARAMS } from '../params/renderParams';
import { jointBilateralUpsample, modelInputSize, normaliseDisparity, resampleRGB, rgbaFrom, toModelTensor } from '../depth/refine';
import { buildIccProfile } from '../io/icc';
import { prepareFocusOverlay } from '../ui/engine/focusCheck';
import { diffusionRenderLongEdge, previewRenderLongEdge } from '../session/renderSize';
import { NativeSource, type NativeSourceHost } from './source';
import { sourceToDisplay, rgbToCanvas, canvasColorSpaceFor } from '../io/display';
import { dcrawGammaCurve, invertDcrawCurve } from '../io/dcrawGamma';
import { iccDescription, colorSpaceForIcc } from '../io/metadata';
import { accumulateScope, shadeScope } from '../ui/model/vectorscope';
import type { ScopePrefs } from '../ui/model/vectorscope';
import { accumulateWaveform, paradeLayout, shadeWaveform, waveformLayout } from '../ui/model/waveform';

export interface NativeRuntimeHost extends NativeRenderHost, NativeSourceHost {
  previewInput(): Float32Array;
  publish(rgba: Uint8ClampedArray, width: number, height: number, gamut: PredefinedColorSpace): void;
  complete(id: number, json: string): void;
  publishMask?(rgba: Uint8ClampedArray, width: number, height: number): void;
  publishCube?(text: string): void;
  publishOriginal?(rgba: Uint8ClampedArray, width: number, height: number, gamut: PredefinedColorSpace): void;
  publishDetail?(rgba: Uint8ClampedArray, original: Uint8ClampedArray, json: string,
    gamut: PredefinedColorSpace, originalGamut: PredefinedColorSpace): void;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** JavaScriptCore has no `btoa` for bytes; scope traces cross as base64. */
function base64(bytes: Uint8ClampedArray): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
    out += BASE64[a >> 2]! + BASE64[((a & 3) << 4) | (b >> 4)]!
      + (i + 1 < bytes.length ? BASE64[((b & 15) << 2) | (c >> 6)]! : '=')
      + (i + 2 < bytes.length ? BASE64[c & 63]! : '=');
  }
  return out;
}

function nativeDisplay(values: Float32Array, width: number, height: number, meta: Parameters<typeof sourceToDisplay>[3]) {
  return sourceToDisplay(values, 4, width * height, meta);
}

/** JavaScriptCore hosts canonical math only; all compute/photography is native. */
export function createNativeRuntime(host: NativeRuntimeHost) {
  const bundle = nativeAssets(host);
  let source: NativeSource | undefined;
  let sourcePreview: { width: number; height: number; rgba: Float32Array } | undefined;
  let sourceBackup: { source: NativeSource | undefined; preview: typeof sourcePreview } | undefined;
  let exportSize = { width: 0, height: 0 };
  const renderer = new NativeRenderer({ ...host, sourceTile(tile, into) {
    if (source) source.region(exportSize.width, exportSize.height, tile.tileOriginX, tile.tileOriginY, tile.tileWidth, tile.tileHeight, into);
    else host.sourceTile(tile, into);
  } }, bundle);
  const defaults: RenderParams = { ...BASELINE_RENDER_PARAMS, inputColorSpace: 'sRGB', inputCctfDecoding: true, autoExposure: false };
  const tasks = new Map<number, Promise<void>>();
  let active = false;
  let guide: { rgba: Uint8ClampedArray; width: number; height: number; rgb: Float32Array; mw: number; mh: number } | undefined;
  let depth: DepthMap | undefined;
  let focusOverlay: ReturnType<typeof prepareFocusOverlay> | undefined;
  // The last displayed preview: what the web scopes trace.
  let display: { pixels: Uint8ClampedArray; width: number; height: number } | undefined;
  return {
    catalog: () => nativeCatalog(bundle),
    profileSpace(buffer: ArrayBuffer): string {
      return colorSpaceForIcc(iccDescription(new Uint8Array(buffer)) ?? '') ?? '';
    },
    rawLookup(): Float32Array {
      return Float32Array.from(invertDcrawCurve(dcrawGammaCurve(0.45, 4.5, 2, 0x10000)), v => v / 65535);
    },
    originalPreview(edge: number): string {
      if (!source) throw new Error('Native source is missing.');
      sourcePreview = source.preview(edge);
      const { rgba, width, height } = sourcePreview, frame = nativeDisplay(rgba, width, height, source.meta);
      host.publishOriginal?.(frame.pixels, width, height, frame.colorSpace);
      return JSON.stringify({ width, height });
    },
    attachSource(json: string): void {
      sourceBackup = { source, preview: sourcePreview };
      source = new NativeSource(host, JSON.parse(json)); sourcePreview = undefined;
    },
    commitSource(): void { sourceBackup = undefined; },
    rollbackSource(): void {
      if (sourceBackup) { source = sourceBackup.source; sourcePreview = sourceBackup.preview; sourceBackup = undefined; }
    },
    clearSource(): void { source = undefined; sourcePreview = undefined; display = undefined; },
    hibernate(): void { renderer.clearResources(); source?.purgeCache(); sourcePreview = undefined; guide = undefined; focusOverlay = undefined; },
    removalInput(json: string, buffer: ArrayBuffer): Float32Array {
      if (!source) throw new Error('Native removal source is missing.');
      const { width, height } = JSON.parse(json) as { width: number; height: number };
      renderer.releaseFrame();
      return source.prepare({ width, height, data: new Uint8Array(buffer) });
    },
    removalResult(buffer: ArrayBuffer): void { if (!source) throw new Error('Native removal source is missing.'); source.finish(new Float32Array(buffer)); },
    removalCommit(): number {
      if (!source) throw new Error('Native removal source is missing.');
      sourcePreview = undefined; return source.commit();
    },
    removalCancel(): void { source?.cancel(); },
    removalRestore(cursor: number): void { source?.restore(cursor); sourcePreview = undefined; },
    removalPreview(edge: number, candidate: boolean): void {
      if (!source) throw new Error('Native removal source is missing.');
      const image = source.preview(edge, candidate);
      const frame = nativeDisplay(image.rgba, image.width, image.height, source.meta);
      host.publish(frame.pixels, image.width, image.height, frame.colorSpace);
    },
    renderSize(json: string): string {
      const { width, height, requested, params, preview } = JSON.parse(json) as {
        width: number; height: number; requested?: number; params: RenderParams; preview: boolean };
      const binding = 32 * 1024 * 1024, budget = 288 * 1024 * 1024;
      let edge = Math.min(Math.max(width, height), requested ?? Math.max(width, height));
      if (preview) edge = previewRenderLongEdge(width, height, edge, params, binding, 768 * 1024 * 1024);
      const scale = edge / Math.max(width, height);
      const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
      edge = diffusionRenderLongEdge(w, h, params, binding, binding, params.lensBlurEnabled, budget);
      const outputScale = edge / Math.max(width, height);
      return JSON.stringify({ width: Math.max(1, Math.round(width * outputScale)), height: Math.max(1, Math.round(height * outputScale)), longEdge: edge });
    },
    setDepth: (depth: DepthMap | undefined) => renderer.setDepth(depth),
    clearDepth: () => { renderer.setDepth(undefined); guide = undefined; depth = undefined; focusOverlay = undefined; },
    focusPreview(json: string): void {
      if (!focusOverlay) return;
      const mask = focusOverlay(JSON.parse(json) as RenderParams);
      // The native texture uses premultiplied alpha, as does Flutter's compositor.
      for (let i = 0; i < mask.pixels.length; i += 4) {
        for (let c = 0; c < 3; c++) mask.pixels[i + c] = mask.pixels[i + c]! * mask.pixels[i + 3]! / 255;
      }
      host.publishMask?.(mask.pixels, mask.width, mask.height);
    },
    icc(label: string): Uint8Array {
      const spec = bundle.manifest.outputColorSpaces[label];
      if (!spec) throw new Error('Unknown output color space');
      return buildIccProfile(spec, label);
    },
    depthInput(width: number, height: number) {
      const input = source ? source.preview(Math.max(width, height)).rgba : host.previewInput();
      const rgba = source ? nativeDisplay(input, width, height, source.meta).pixels : Uint8ClampedArray.from(input, v => v * 255);
      const [mw, mh] = modelInputSize(width, height, 392);
      const rgb = resampleRGB(rgba, width, height, mw, mh);
      guide = { rgba, width, height, rgb, mw, mh };
      return { data: toModelTensor(rgb, mw, mh), width: mw, height: mh };
    },
    depthResult(buffer: ArrayBuffer, ow: number, oh: number): void {
      if (!guide) throw new Error('Depth guide is missing');
      const { rgba, width, height, rgb, mw, mh } = guide;
      const low = ow === mw && oh === mh ? rgb : resampleRGB(rgbaFrom(rgb, mw, mh), mw, mh, ow, oh);
      const raw = new Float32Array(buffer);
      if (raw.length !== ow * oh || raw.some(v => !Number.isFinite(v))) throw new Error('Invalid depth inference');
      depth = { width, height, data: normaliseDisparity(jointBilateralUpsample(raw, ow, oh, low, rgba, width, height)) };
      renderer.setDepth(depth);
      guide = undefined;
    },
    dispose: () => renderer.dispose(),
    /** Waveform, parade or vectorscope trace (web Waveform/Vectorscope), RGBA in base64. */
    scope(json: string): string {
      if (!display) return '{}';
      const { prefs, width, height } = JSON.parse(json) as { prefs: ScopePrefs; width: number; height: number };
      const { pixels } = display;
      if (prefs.kind === 'vectorscope') {
        const px = Math.max(64, Math.round(width));
        const radiusPx = (px / 2) * 0.8;
        const trace = accumulateScope(pixels, display.width, display.height, px, radiusPx, prefs.zoom, undefined, prefs.range);
        return JSON.stringify({ width: px, height: px, rgba: base64(shadeScope(trace, prefs.colorize, 1, (radiusPx * prefs.zoom) / 0.5)) });
      }
      const w = Math.max(32, Math.round(width)), h = Math.max(32, Math.round(height));
      const layout = prefs.kind === 'parade' ? paradeLayout(prefs.paradeMode) : waveformLayout(prefs.waveMode, prefs.waveChannels);
      const trace = accumulateWaveform(pixels, display.width, display.height, w, h, layout, { lowPass: prefs.lowPass });
      return JSON.stringify({ width: w, height: h, rgba: base64(shadeWaveform(trace, prefs.waveColorize, prefs.extents)) });
    },
    controls(json: string): string {
      // `viewAspect` (lebar/tinggi foto) hanya untuk readout kedalaman ruang.
      const { viewAspect, ...rest } = JSON.parse(json) as RenderParams & { viewAspect?: number };
      const params = rest as RenderParams;
      // Tampilan panel web (ToolControls.tsx): nilai, sakelar, reset, petunjuk.
      const display = (tool: Tool) => {
        switch (tool.kind) {
          case 'slider':
            return { range: sliderRange(tool, params), position: sliderPosition(tool, params),
              defaultPosition: sliderPosition(tool, { ...params, [tool.field]: defaults[tool.field] }) };
          case 'stepper': {
            const { text, hint } = stepperDisplay(tool, params);
            return { valueText: text, hint, atMin: stepperAtEnd(tool, params, -1), atMax: stepperAtEnd(tool, params, 1) };
          }
          case 'diffusion':
            return { strength: params[tool.strengthField], strengthRange: DIFFUSION_STRENGTH,
              strengthText: params[tool.enabledBy] ? `${formatStops(params[tool.strengthField])} stop` : 'Off',
              defaultStrength: defaults[tool.strengthField] };
          case 'toggle':
            return tool.field === 'inputCctfDecoding' && !decodeAllowed(params.inputColorSpace)
              ? { note: `Not available for ${params.inputColorSpace}.` } : {};
          case 'lens':
            return params.lensBlurEnabled ? { readout: lensReadoutText(params, viewAspect ?? 1.5) } : {};
          default:
            return {};
        }
      };
      return JSON.stringify(GROUPS.map(group => {
        const tools = visibleTools(group, params).map(tool => ({
          ...tool, valueText: valueText(tool, params), modified: isModified(tool, params, defaults),
          enabled: toolEnabled(tool, params),
          resettable: (tool.kind === 'slider' || tool.kind === 'stepper' || tool.kind === 'diffusion') && isModified(tool, params, defaults),
          ...display(tool),
        }));
        return { ...group, tools, modified: tools.some(tool => tool.modified) };
      }));
    },
    patch(json: string): string {
      const { params, action, id, value } = JSON.parse(json) as {
        params: RenderParams; action: 'position' | 'choice' | 'step' | 'reset' | 'film' | 'paper' | 'toggle' | 'fields'; id: string; value: unknown;
      };
      let patch: Partial<RenderParams>;
      if (action === 'film' || action === 'paper') patch = stockPatch(action, String(value), params);
      else if (action === 'fields') patch = value as Partial<RenderParams>;
      else {
        const tool = findTool(id);
        if (action === 'position' && tool.kind === 'slider') patch = positionPatch(tool, Number(value), params);
        else if (action === 'choice' && tool.kind === 'choice') patch = choicePatch(tool, String(value), params);
        else if (action === 'step' && tool.kind === 'stepper') patch = stepperPatch(tool, params, Number(value) < 0 ? -1 : 1);
        else if (action === 'reset') patch = resetPatch(tool, defaults);
        else if (action === 'toggle' && 'field' in tool) patch = { [tool.field]: Boolean(value) };
        else throw new Error('Unsupported native control action');
      }
      return JSON.stringify({ ...params, ...normalizePatch(params, patch) });
    },
    request(id: number, json: string): void {
      if (active || tasks.has(id)) { host.complete(id, JSON.stringify({ error: 'Native renderer is busy' })); return; }
      active = true;
      const task = Promise.resolve().then(async () => {
        try {
          const request = JSON.parse(json) as { operation: 'preview' | 'export' | 'cube' | 'detail'; size?: number; params: RenderParams;
            width: number; height: number; measureWidth?: number; measureHeight?: number;
            region?: { x: number; y: number; width: number; height: number } };
          if (request.operation === 'cube') {
            host.publishCube?.(await renderer.exportCube(request.params, request.size ?? 33));
            host.complete(id, '{"result":null}'); return;
          }
          if (request.operation === 'detail') {
            if (!source || !request.region) throw new Error('Native detail source is missing');
            exportSize = { width: request.width, height: request.height };
            const region = request.region, measure = source.measurement(request.width, request.height);
            const rgb = await renderer.detail(request.params, request.width, request.height, measure, region);
            if (rgb) {
              const original = source.region(request.width, request.height, region.x, region.y, region.width, region.height, undefined, false, true);
              const gamut = canvasColorSpaceFor(request.params.outputColorSpace);
              const before = nativeDisplay(original, region.width, region.height, source.meta);
              host.publishDetail?.(rgbToCanvas(rgb, region.width, region.height, request.params.outputColorSpace, gamut),
                before.pixels, JSON.stringify({ ...region, fullWidth: request.width, fullHeight: request.height }), gamut, before.colorSpace);
            }
            host.complete(id, '{"result":null}'); return;
          }
          if (source && request.operation === 'preview' && (sourcePreview?.width !== request.width || sourcePreview.height !== request.height)) {
            sourcePreview = { width: request.width, height: request.height,
              rgba: source.region(request.width, request.height, 0, 0, request.width, request.height) };
          }
          // Memory pressure deliberately drops the preview. File-backed exports
          // obtain their measurement and tiles from source, so they must never
          // request the now-empty legacy preview buffer while recovering.
          const input = sourcePreview?.rgba ?? (source ? new Float32Array() : host.previewInput());
          if (request.operation === 'preview') {
            const rgb = await renderer.preview(request.params, input, request.width, request.height);
            const gamut = canvasColorSpaceFor(request.params.outputColorSpace);
            const pixels = rgbToCanvas(rgb, request.width, request.height, request.params.outputColorSpace, gamut);
            host.publish(pixels, request.width, request.height, gamut);
            display = { pixels, width: request.width, height: request.height };
            if (depth) {
              focusOverlay = prepareFocusOverlay({ width: request.width, height: request.height, pixels, colorSpace: gamut }, depth);
            }
          } else if (request.operation === 'export') {
            exportSize = { width: request.width, height: request.height };
            const measure = source?.measurement(request.width, request.height);
            await renderer.export(request.params, request.width, request.height, measure?.rgba ?? input,
              measure?.width ?? sourcePreview?.width ?? request.measureWidth!, measure?.height ?? sourcePreview?.height ?? request.measureHeight!);
          } else throw new Error('Unknown native operation');
          host.complete(id, '{"result":null}');
        } catch (error) {
          host.complete(id, JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        } finally { active = false; tasks.delete(id); }
      });
      tasks.set(id, task);
    },
  };
}
