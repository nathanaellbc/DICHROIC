// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Slider } from '../../src/ui/components/controls';

let root: Root;
let host: HTMLDivElement;
let slider: HTMLElement;
let events: Array<boolean | number>;

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  window.matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as MediaQueryList);
  events = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(createElement(Slider, {
    min: 0, max: 100, step: 1, value: 50, valueText: '50', label: 'Temperature',
    onChange: (value) => events.push(value),
    onInteractionChange: (active) => events.push(active),
  })));
  slider = host.querySelector('[role="slider"]')!;
  slider.setPointerCapture = vi.fn();
  vi.spyOn(host.querySelector('.slider-track')!, 'getBoundingClientRect').mockReturnValue({
    left: 0, width: 100, top: 0, height: 4, bottom: 4, right: 100, x: 0, y: 0, toJSON: () => ({}),
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function pointer(type: string, clientX: number) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { clientX, pointerId: 1, pointerType: 'touch' });
  await act(async () => slider.dispatchEvent(event));
}

it('flushes the final drag value before restoring detail even before the next animation frame', async () => {
  await pointer('pointerdown', 50);
  await pointer('pointermove', 65);
  await pointer('pointermove', 80);
  expect(events).toEqual([true]);
  await pointer('pointerup', 80);
  expect(events).toEqual([true, 80, false]);
});

it('ends a held keyboard adjustment on keyup', async () => {
  await act(async () => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
  expect(events).toEqual([true, 51]);
  await act(async () => slider.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })));
  expect(events).toEqual([true, 51, false]);
});

it('restores detail when pointer capture is lost and does not finish twice', async () => {
  await pointer('pointerdown', 50);
  await pointer('pointermove', 60);
  await pointer('lostpointercapture', 60);
  await pointer('pointerup', 60);
  expect(events).toEqual([true, 60, false]);
});
