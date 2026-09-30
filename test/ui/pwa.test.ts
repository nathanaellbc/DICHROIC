import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ phase: 'editing', subscriber: undefined as (() => void) | undefined,
  refresh: undefined as (() => void) | undefined, update: vi.fn() }));
vi.mock('virtual:pwa-register', () => ({ registerSW: (options: { onNeedRefresh: () => void }) => {
  state.refresh = options.onNeedRefresh; return state.update;
} }));
vi.mock('../../src/ui/engine/engine', () => ({ engine: {
  getState: () => ({ phase: state.phase }), subscribe: (callback: () => void) => { state.subscriber = callback; },
} }));

let controllerChange: (() => void) | undefined;
const reload = vi.fn();
beforeEach(() => {
  vi.resetAllMocks(); vi.resetModules(); vi.stubEnv('DEV', false);
  state.phase = 'editing'; state.subscriber = undefined; state.refresh = undefined;
  const storage = () => {
    const data = new Map<string, string>();
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key) };
  };
  vi.stubGlobal('window', { crossOriginIsolated: false, location: { reload }, localStorage: storage(), sessionStorage: storage() });
  vi.stubGlobal('navigator', { serviceWorker: { controller: {}, ready: Promise.resolve(),
    addEventListener: (_name: string, callback: () => void) => { controllerChange = callback; },
  } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('PWA lifecycle', () => {
  it('defers an available update until the photo is closed', async () => {
    const { startPwa } = await import('../../src/ui/pwa'); startPwa();
    state.refresh!(); expect(state.update).not.toHaveBeenCalled();
    state.phase = 'idle'; state.subscriber!();
    expect(state.update).toHaveBeenCalledExactlyOnceWith(true);
    state.subscriber!(); expect(state.update).toHaveBeenCalledOnce();
  });
  it('never reloads an open photo for isolation and retries only once when idle', async () => {
    const { startPwa } = await import('../../src/ui/pwa'); startPwa(); await Promise.resolve();
    controllerChange!(); expect(reload).not.toHaveBeenCalled();
    state.phase = 'idle'; controllerChange!(); controllerChange!();
    expect(reload).toHaveBeenCalledOnce();
  });
});
