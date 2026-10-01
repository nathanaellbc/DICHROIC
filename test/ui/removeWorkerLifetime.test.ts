// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const mocked = vi.hoisted(() => ({
  prepareRemoval: vi.fn(),
  applyRemoval: vi.fn(),
  canUndoRemoval: false,
}));

vi.mock('../../src/ui/engine/engine', () => ({ engine: mocked }));
vi.mock('../../src/ui/components/controls', async () => {
  const { createElement: h } = await import('react');
  return {
    PressButton: ({ children, ...props }: { children: unknown; onClick?: () => void; disabled?: boolean }) =>
      h('button', props, children as never),
    Slider: () => null,
  };
});
vi.mock('../../src/ui/components/Icon', async () => {
  const { createElement: h } = await import('react');
  return { Icon: () => h('span') };
});
vi.mock('../../src/ui/components/PhotoView', async () => {
  const { createElement: h } = await import('react');
  return {
    PhotoView: ({ brush, content }: { brush: { onStart: (point: { x: number; y: number }, width: number) => void; onEnd: (cancel: boolean) => void }; content: ReactNode }) =>
      h('div', null, content, h('button', { onClick: () => { brush.onStart({ x: 0.5, y: 0.5 }, 512); brush.onEnd(false); } }, 'Paint')),
  };
});
import { RemoveContent } from '../../src/ui/screens/Remove';

class FakeWorker {
  static latest: FakeWorker | undefined;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.latest = this; }
}

let root: Root;
let host: HTMLDivElement;
let preview: HTMLDivElement;
let controls: HTMLDivElement;

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((node) => node.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ImageData', class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  });
  FakeWorker.latest = undefined;
  vi.stubGlobal('Worker', FakeWorker);
  mocked.prepareRemoval.mockResolvedValue({
    revision: 1, x: 0, y: 0, width: 1, height: 1,
    rgb: new Float32Array(512 * 512 * 3), mask: new Float32Array(512 * 512).fill(1),
  });
  mocked.applyRemoval.mockResolvedValue(undefined);
  host = document.createElement('div');
  preview = document.createElement('div');
  controls = document.createElement('div');
  document.body.append(host, preview, controls);
  root = createRoot(host);
  const context = {
    clearRect: vi.fn(), drawImage: vi.fn(), getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) })),
    putImageData: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as never);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove(); preview?.remove(); controls?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('releases the LaMa worker as soon as its result returns', async () => {
  const frame = { width: 1, height: 1, pixels: new Uint8ClampedArray(4), colorSpace: 'srgb' as const };
  await act(async () => root.render(createElement(RemoveContent, {
    original: frame, sourceSize: { width: 1, height: 1 }, previewTarget: preview, controlsTarget: controls, onClose: vi.fn(),
  })));
  await act(async () => { button('Paint').click(); });
  await act(async () => { button('Remove').click(); await Promise.resolve(); });
  const worker = FakeWorker.latest!;
  expect(worker.postMessage).toHaveBeenCalledOnce();

  await act(async () => worker.onmessage?.({ data: { output: new Float32Array(512 * 512 * 3) } } as MessageEvent));
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain('Preview ready. Apply to keep this removal.');
});
