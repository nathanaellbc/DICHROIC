// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DecryptedText } from '../../src/ui/components/DecryptedText';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('renders text with screen reader accessible element', async () => {
  await act(async () => {
    root.render(createElement(DecryptedText, { text: 'Download · 14.2 MB', speed: 10 }));
  });

  const srOnly = host.querySelector('.sr-only');
  expect(srOnly?.textContent).toBe('Download · 14.2 MB');
  expect(host.textContent).toContain('Download · 14.2 MB');
});

it('reveals text sequentially until fully decrypted', async () => {
  vi.useFakeTimers();
  try {
    await act(async () => {
      root.render(createElement(DecryptedText, { text: 'Download · 5 MB', speed: 20, maxIterations: 5 }));
    });

    // Advance fake timers through the decryption cycle
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        vi.advanceTimersByTime(20);
      });
    }

    const visibleSpan = host.querySelector('[aria-hidden="true"]');
    expect(visibleSpan?.textContent).toBe('Download · 5 MB');
  } finally {
    vi.useRealTimers();
  }
});
