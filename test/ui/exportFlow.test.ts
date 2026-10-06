// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const worker = vi.hoisted(() => ({
  exportFormats: vi.fn(), renderExport: vi.fn(), exportImage: vi.fn(),
  exportCube: vi.fn(), releaseExport: vi.fn(),
}));
const shareSheet = vi.hoisted(() => ({ mobile: false }));
vi.mock('../../src/ui/engine/engine', () => ({ engine: {
  imageSize: { width: 6000, height: 4000 }, ...worker,
} }));
vi.mock('../../src/ui/share', () => ({
  prefersShareSheet: () => shareSheet.mobile,
  saveViaDownload: vi.fn(), saveViaShare: vi.fn(),
  formatBytes: (n: number) => `${n} B`,
}));
vi.mock('../../src/ui/components/controls', async () => {
  const { createElement: h } = await import('react');
  return {
    PressButton: ({ children, ...props }: { children: unknown; disabled?: boolean; onClick?: () => void }) =>
      h('button', props, children as never),
    Segmented: ({ items, value, onChange, label }: {
      items: readonly { value: string; label: string }[]; value: string;
      onChange: (value: string) => void; label: string;
    }) => h('div', { 'aria-label': label }, items.map((item) =>
      h('button', { key: item.value, 'aria-pressed': value === item.value, onClick: () => onChange(item.value) }, item.label))),
    Slider: () => h('div'),
  };
});
vi.mock('../../src/ui/components/ThoughtLine', async () => {
  const { createElement: h } = await import('react');
  return {
    formatElapsed: (ds: number) => `${(ds / 10).toFixed(1)}s`,
    ThoughtLine: ({ working, label, doneLabel }: { working: boolean; label: string; doneLabel: string }) =>
      h('div', { 'data-testid': 'thought-line', 'data-working': working }, working ? label : doneLabel),
  };
});
import { ExportContent } from '../../src/ui/screens/Export';

let host: HTMLDivElement;
let root: Root;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll('button')).find((node) => node.textContent?.trim().startsWith(label));
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

async function click(label: string) {
  await act(async () => { button(label).click(); });
}

async function finishEncode() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  worker.exportFormats.mockResolvedValue(['png8', 'jpeg']);
  worker.renderExport.mockResolvedValue({ width: 6000, height: 4000, limited: false });
  worker.exportImage.mockImplementation((format: string) => Promise.resolve(new File(['pixels'], `photo.${format}`, { type: 'image/png' })));
  worker.exportCube.mockResolvedValue(new File(['cube'], 'photo.cube'));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(ExportContent, {
      outputColorSpace: 'sRGB', inputColorSpace: 'sRGB', recipe: 'Portra 400',
      onDone: vi.fn(), onCancel: vi.fn(), onError: vi.fn(),
    }));
  });
});

afterEach(async () => {
  shareSheet.mobile = false;
  if (root) await act(async () => root.unmount());
  host?.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('does no export rendering on open and prepares the file only after Develop', async () => {
  expect(worker.renderExport).not.toHaveBeenCalled();
  expect(worker.exportImage).not.toHaveBeenCalled();
  const render = deferred<{ width: number; height: number; limited: boolean }>();
  worker.renderExport.mockReturnValueOnce(render.promise);
  await click('Develop');
  expect(worker.renderExport).toHaveBeenCalledTimes(1);
  expect(worker.renderExport).toHaveBeenCalledWith(undefined, expect.objectContaining({ width: 6000, height: 4000 }), expect.objectContaining({ target: 'rgb8' }));
  expect(host.querySelector('[data-testid="thought-line"]')?.getAttribute('data-working')).toBe('true');
  expect(worker.exportImage).not.toHaveBeenCalled();
  await act(async () => render.resolve({ width: 6000, height: 4000, limited: false }));
  await finishEncode();
  expect(worker.exportImage).toHaveBeenCalledWith('png8', { longEdge: undefined, quality: 0.92 });
  expect(host.querySelector('[data-testid="thought-line"]')?.getAttribute('data-working')).toBe('false');
  expect(Array.from(host.querySelectorAll('button')).some((node) => node.textContent?.includes('Download') && !node.disabled)).toBe(true);
});

it('keeps stale files disabled while re-encoding, and switching tabs does not start another render', async () => {
  await click('Develop');
  await finishEncode();
  expect(worker.renderExport).toHaveBeenCalledTimes(1);
  await click('JPEG');
  expect(Array.from(host.querySelectorAll('button')).some((node) => node.textContent?.includes('Download') && !node.disabled)).toBe(false);
  await finishEncode();
  expect(worker.exportImage).toHaveBeenLastCalledWith('jpeg', { longEdge: undefined, quality: 0.92 });
  expect(worker.renderExport).toHaveBeenCalledTimes(1);
  await click('LUT (.cube)');
  await click('Image');
  expect(worker.renderExport).toHaveBeenCalledTimes(1);
});

it('allows retry after a failed render without encoding the stale result', async () => {
  worker.renderExport.mockRejectedValueOnce(new Error('GPU unavailable'));
  await click('Develop');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('GPU unavailable');
  expect(worker.exportImage).not.toHaveBeenCalled();
  await click('Develop');
  await finishEncode();
  expect(worker.renderExport).toHaveBeenCalledTimes(2);
  expect(worker.exportImage).toHaveBeenCalledTimes(1);
});

it('waits for another Develop after a size change and ignores an older render finishing late', async () => {
  const old = deferred<{ width: number; height: number; limited: boolean }>();
  worker.renderExport.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ width: 2048, height: 1365, limited: false });
  await click('Develop');
  await click('2048');
  expect(worker.renderExport).toHaveBeenCalledTimes(1);
  await click('Develop');
  expect(worker.renderExport).toHaveBeenLastCalledWith(2048, expect.objectContaining({ width: 2048, height: 1365 }), expect.objectContaining({ target: 'rgb8' }));
  await act(async () => old.resolve({ width: 6000, height: 4000, limited: false }));
  await finishEncode();
  expect(worker.exportImage).toHaveBeenCalledTimes(1);
  expect(worker.exportImage).toHaveBeenCalledWith('png8', { longEdge: 2048, quality: 0.92 });
});

it('HP (lembar share): hanya Save to Photos, tanpa tombol Download', async () => {
  shareSheet.mobile = true;
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(ExportContent, {
      outputColorSpace: 'sRGB', inputColorSpace: 'sRGB', recipe: 'Portra 400',
      onDone: vi.fn(), onCancel: vi.fn(), onError: vi.fn(),
    }));
  });
  await click('Develop');
  await finishEncode();
  const labels = Array.from(host.querySelectorAll('button')).map((node) => node.textContent ?? '');
  expect(labels.some((label) => label.includes('Download'))).toBe(false);
  expect(button('Save to Photos').disabled).toBe(false);
});
