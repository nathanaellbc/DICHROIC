import { nativeAssets, nativeCatalog, NativeRenderer, type NativeRenderHost } from './renderer';
import type { RenderParams } from '../params/renderParams';
import type { DepthMap } from '../host/lens';
import { GROUPS, choicePatch, findTool, isModified, normalizePatch, positionPatch,
  resetPatch, sliderPosition, sliderRange, stepperPatch, stockPatch, valueText, visibleTools } from '../ui/model/tools';
import { BASELINE_RENDER_PARAMS } from '../params/renderParams';

export interface NativeRuntimeHost extends NativeRenderHost {
  previewInput(): Float32Array;
  publish(rgb: Float32Array, width: number, height: number): void;
  complete(id: number, json: string): void;
}

/** JavaScriptCore hosts canonical math only; all compute/photography is native. */
export function createNativeRuntime(host: NativeRuntimeHost) {
  const bundle = nativeAssets(host);
  const renderer = new NativeRenderer(host, bundle);
  const tasks = new Map<number, Promise<void>>();
  let active = false;
  return {
    catalog: () => nativeCatalog(bundle),
    setDepth: (depth: DepthMap | undefined) => renderer.setDepth(depth),
    dispose: () => renderer.dispose(),
    controls(json: string): string {
      const params = JSON.parse(json) as RenderParams;
      return JSON.stringify(GROUPS.map(group => ({ ...group, tools: visibleTools(group, params).map(tool => ({
        ...tool, valueText: valueText(tool, params), modified: isModified(tool, params, BASELINE_RENDER_PARAMS),
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
        else if (action === 'reset') patch = resetPatch(tool, BASELINE_RENDER_PARAMS);
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
