// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateModal } from '../../src/ui/modalFocus';

const cleanups: Array<() => void> = [];
beforeEach(() => {
  document.body.innerHTML = '<main><button id="trigger">Open</button></main><section id="dialog"><button id="first">First</button><button id="last">Last</button></section>';
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
  document.getElementById('trigger')!.focus();
});
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });

describe('modal keyboard access', () => {
  it('makes the background inert, traps both Tab directions, and restores focus', () => {
    const dialog = document.getElementById('dialog')!;
    const cleanup = activateModal(dialog); cleanups.push(cleanup);
    expect(document.querySelector('main')!.inert).toBe(true);
    expect(document.activeElement?.id).toBe('first');
    document.getElementById('last')!.focus();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement?.id).toBe('first');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement?.id).toBe('last');
    cleanups.pop()!();
    expect(document.querySelector('main')!.inert).toBeFalsy();
    expect(document.activeElement?.id).toBe('trigger');
  });

  it('keeps the background disabled when the underlying dialog closes first', () => {
    const lower = activateModal(document.getElementById('dialog')!);
    const alert = document.createElement('section'); alert.innerHTML = '<button>OK</button>'; document.body.appendChild(alert);
    const upper = activateModal(alert); cleanups.push(upper);
    lower();
    expect(document.querySelector('main')!.inert).toBe(true);
    expect(document.activeElement).toBe(alert.querySelector('button'));
  });

  it('restores a nested dialog to its invoking control', () => {
    cleanups.push(activateModal(document.getElementById('dialog')!));
    const previous = document.activeElement;
    const alert = document.createElement('section'); alert.innerHTML = '<button>OK</button>'; document.body.appendChild(alert);
    const cleanup = activateModal(alert); cleanup();
    expect(document.activeElement).toBe(previous);
    expect(document.querySelector('main')!.inert).toBe(true);
  });
});
