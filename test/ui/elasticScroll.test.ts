// @vitest-environment jsdom
import { act, createElement } from 'react';
import type { PointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useElasticScroll } from '../../src/ui/components/useElasticScroll';

it('leaves touch swipes to native scrolling without layout reads or scroll writes', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let scroll!: ReturnType<typeof useElasticScroll>;
  function Harness() {
    scroll = useElasticScroll();
    return createElement('div', { ref: scroll.ref }, createElement('div'));
  }
  await act(async () => root.render(createElement(Harness)));
  const el = scroll.ref.current!;
  const readScroll = vi.fn(() => 0), writeScroll = vi.fn();
  Object.defineProperty(el, 'scrollLeft', { get: readScroll, set: writeScroll });
  const layout = vi.spyOn(window, 'getComputedStyle');
  const capture = vi.fn(), preventDefault = vi.fn();
  el.setPointerCapture = capture;
  const event = (x: number) => ({ currentTarget: el, target: el, isPrimary: true, button: 0,
    pointerType: 'touch', pointerId: 1, clientX: x, clientY: 10, preventDefault }) as unknown as PointerEvent<HTMLDivElement>;
  try {
    await act(async () => {
      scroll.handlers.onPointerDown(event(300));
      for (let x = 290; x >= 0; x -= 10) scroll.handlers.onPointerMove(event(x));
      scroll.handlers.onPointerCancel(event(0));
    });
    expect(layout).not.toHaveBeenCalled();
    expect(readScroll).not.toHaveBeenCalled();
    expect(writeScroll).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  } finally {
    layout.mockRestore();
    await act(async () => root.unmount());
    host.remove();
  }
});
