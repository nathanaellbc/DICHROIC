import { describe, it, expect } from 'vitest';
import { preventPageZoom } from '../../src/ui/noZoom';

/** Event tiruan yang bisa dibatalkan (Node tidak punya TouchEvent/WheelEvent). */
function fire(target: EventTarget, type: string, extra: Record<string, unknown> = {}): boolean {
  const e = Object.assign(new Event(type, { cancelable: true }), extra);
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

describe('zoom halaman diblokir, zoom foto tidak', () => {
  const win = new EventTarget() as EventTarget & { document: EventTarget };
  win.document = new EventTarget();
  preventPageZoom(win as unknown as Window);

  it('pinch iOS (gesture*) dan touchmove dua jari dibatalkan; satu jari tidak', () => {
    expect(fire(win.document, 'gesturestart')).toBe(true);
    expect(fire(win.document, 'gesturechange')).toBe(true);
    expect(fire(win.document, 'touchmove', { touches: { length: 2 } })).toBe(true);
    expect(fire(win.document, 'touchmove', { touches: { length: 1 } })).toBe(false);
  });

  it('desktop: Ctrl/⌘ + roda dan Ctrl/⌘ + = - 0 dibatalkan; gulir biasa dan pintasan lain tidak', () => {
    expect(fire(win, 'wheel', { ctrlKey: true })).toBe(true);
    expect(fire(win, 'wheel', { metaKey: true })).toBe(true);
    expect(fire(win, 'wheel', {})).toBe(false);
    for (const key of ['=', '+', '-', '0']) expect(fire(win, 'keydown', { ctrlKey: true, key }), key).toBe(true);
    expect(fire(win, 'keydown', { metaKey: true, key: 'z' })).toBe(false);
    expect(fire(win, 'keydown', { key: '0' })).toBe(false);
  });
});
