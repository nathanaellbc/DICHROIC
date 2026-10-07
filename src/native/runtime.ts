import { nativeAssets, nativeCatalog, NativeRenderer, type NativeRenderHost } from './renderer';
import type { RenderParams } from '../params/renderParams';
import type { DepthMap } from '../host/lens';
import { GROUPS, choicePatch, findTool, isModified, normalizePatch, positionPatch,
  resetPatch, sliderPosition, sliderRange, stepperPatch, stockPatch, valueText, visibleTools } from '../ui/model/tools';
import { BASELINE_RENDER_PARAMS } from '../params/renderParams';
import { jointBilateralUpsample, modelInputSize, normaliseDisparity, resampleRGB, rgbaFrom, toModelTensor } from '../depth/refine';
import { buildIccProfile } from '../io/icc';
import { prepareFocusOverlay } from '../ui/engine/focusCheck';
import { diffusionRenderLongEdge, previewRenderLongEdge } from '../session/renderSize';

export interface NativeRuntimeHost extends NativeRenderHost {
  previewInput(): Float32Array;
  publish(rgb: Float32Array, width: number, height: number): void;
  complete(id: number, json: string): void;
  publishMask?(rgba: Uint8ClampedArray, width: number, height: number): void;
}

/** JavaScriptCore hosts canonical math only; all compute/photography is native. */
export function createNativeRuntime(host: NativeRuntimeHost) {
  const bundle = nativeAssets(host);
  const renderer = new NativeRenderer(host, bundle);
  const defaults: RenderParams = { ...BASELINE_RENDER_PARAMS, inputColorSpace: 'sRGB', inputCctfDecoding: true, autoExposure: false };
  const tasks = new Map<number, Promise<void>>();
  let active = false;
  let guide: { rgba: Uint8ClampedArray; width: number; height: number; rgb: Float32Array; mw: number; mh: number } | undefined;
  let depth: DepthMap | undefined;
  let focusOverlay: ReturnType<typeof prepareFocusOverlay> | undefined;
  return {
    catalog: () => nativeCatalog(bundle),
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
      const source = host.previewInput();
      const rgba = Uint8ClampedArray.from(source, v => v * 255);
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
    controls(json: string): string {
      const params = JSON.parse(json) as RenderParams;
      return JSON.stringify(GROUPS.map(group => ({ ...group, tools: visibleTools(group, params).map(tool => ({
        ...tool, valueText: valueText(tool, params), modified: isModified(tool, params, defaults),
        ...(tool.kind === 'slider' ? { range: sliderRange(tool, params), position: sliderPosition(tool, params) } : {}),
      })) })));
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
          const request = JSON.parse(json) as { operation: 'preview' | 'export'; params: RenderParams;
            width: number; height: number; measureWidth?: number; measureHeight?: number };
          const input = host.previewInput();
          if (request.operation === 'preview') {
            const rgb = await renderer.preview(request.params, input, request.width, request.height);
            host.publish(rgb, request.width, request.height);
            if (depth) {
              const pixels = new Uint8ClampedArray(request.width * request.height * 4);
              for (let i = 0; i < request.width * request.height; i++) {
                for (let c = 0; c < 3; c++) pixels[i * 4 + c] = rgb[i * 3 + c]! * 255;
                pixels[i * 4 + 3] = 255;
              }
              focusOverlay = prepareFocusOverlay({ width: request.width, height: request.height, pixels, colorSpace: 'srgb' }, depth);
            }
          } else if (request.operation === 'export') {
            await renderer.export(request.params, request.width, request.height, input,
              request.measureWidth!, request.measureHeight!);
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
