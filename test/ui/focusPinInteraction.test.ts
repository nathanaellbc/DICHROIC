// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PhotoView } from '../../src/ui/components/PhotoView';

let root: Root;
let host: HTMLDivElement;
let area: HTMLElement;
let pin: HTMLElement;
let events: Array<string | number[]>;
function Harness() {
  const [picking, setPicking] = useState(false);
  const [point, setPoint] = useState({ x: .5, y: .5 });
  return createElement(PhotoView, {
    original: { width: 200, height: 100, colorSpace: 'srgb', pixels: new Uint8ClampedArray(80000) },
    photoKey: 'test', label: 'Photo', compare: false, rendering: false,
    focus: { ...point, show: true, picking,
      onStart: () => { events.push('start'); setPicking(true); },
      onPreview: (x, y) => events.push([x, y]),
      onPick: (x, y) => { events.push('commit', [x, y]); setPoint({ x, y }); setPicking(false); },
      onPreviewCancel: () => { events.push('cancel'); setPicking(false); },
    },
  });
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ImageData', class {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData: vi.fn() } as never);
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: ResizeObserverCallback) {} observe() { this.callback([{ contentRect: { width: 200, height: 100 } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() {} });
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  events = []; host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(createElement(Harness)));
  area = host.firstElementChild as HTMLElement;
  area.setPointerCapture = vi.fn();
  pin = host.querySelector('[data-focus-pin]')!;
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function pointer(type: string, x: number, y = 50, target = area, id = 1) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { clientX: x, clientY: y, pointerId: id, pointerType: 'touch' });
  await act(async () => target.dispatchEvent(event));
}
it('starts only on the pin and commits the final position before exiting isolation', async () => {
  await pointer('pointerdown', 100, 50, pin);
  expect(events).toEqual(['start']);
  expect(area.getAttribute('role')).toBe('application');
  await pointer('pointermove', 150);
  await pointer('pointerup', 160);
  expect(events).toEqual(['start', [.8, .5], 'commit', [.8, .5]]);
  expect(area.getAttribute('role')).toBeNull();
  await pointer('lostpointercapture', 160);
  expect(events.filter(e => e === 'commit')).toHaveLength(1);
});
it('keeps the grab offset and clamps captured drags to the photo', async () => {
  await pointer('pointerdown', 110, 50, pin);
  await pointer('pointerup', 130);
  expect(events.at(-1)).toEqual([.6, .5]);
  await pointer('pointerdown', 120, 50, pin);
  await pointer('pointerup', 350, -20);
  expect(events.at(-1)).toEqual([1, 0]);
});
it('cancels isolation without committing on capture loss or a second finger', async () => {
  await pointer('pointerdown', 100, 50, pin);
  await pointer('pointermove', 150);
  await pointer('lostpointercapture', 150);
  expect(events).toEqual(['start', 'cancel']);
  expect(area.getAttribute('role')).toBeNull();
  await pointer('pointerdown', 100, 50, pin);
  await pointer('pointerdown', 130, 50, area, 2);
  expect(events.at(-1)).toBe('cancel');
  await pointer('pointerup', 130, 50, area, 2);
  await pointer('pointerup', 100);
  expect(events).not.toContain('commit');
});
it('keeps ordinary photo presses separate and allows keyboard focus adjustment', async () => {
  await pointer('pointerdown', 150);
  await pointer('pointerup', 150);
  expect(events).toEqual([]);
  await act(async () => pin.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(events).toEqual(['commit', [.52, .5]]);
});
