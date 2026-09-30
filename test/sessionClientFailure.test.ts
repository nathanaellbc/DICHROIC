import { describe, expect, it, vi } from 'vitest';
import { SessionClient } from '../src/session/client';
import type { MessagePortLike } from '../src/session/protocol';

function portHarness() {
  const listeners = new Map<string, (e: { data?: unknown; message?: string }) => void>();
  const port: MessagePortLike = {
    postMessage: vi.fn(), terminate: vi.fn(),
    addEventListener: (type, listener) => { listeners.set(type, listener); },
    removeEventListener: (type) => { listeners.delete(type); },
  };
  return { port, listeners };
}

describe('Session worker failures', () => {
  it.each(['error', 'messageerror'])('%s rejects every pending RPC and detaches the port', async (event) => {
    const { port, listeners } = portHarness();
    const failure = vi.fn();
    const client = SessionClient.attach(port, failure);
    const pending = [client.init({ assetsBaseUrl: '/data' }), client.render('preview')];
    const results = Promise.allSettled(pending);
    listeners.get(event)!({ message: 'worker failed' });
    expect((await results).every((r) => r.status === 'rejected')).toBe(true);
    expect(listeners.size).toBe(0);
    expect(port.terminate).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledOnce();
    await expect(client.getParams()).rejects.toThrow('worker failed');
  });

  it('GPU device loss rejects an in-flight export', async () => {
    const { port, listeners } = portHarness();
    const client = SessionClient.attach(port);
    const result = expect(client.exportImage('png8')).rejects.toThrow('GPU lost');
    listeners.get('message')!({ data: { id: 0, ok: false, error: { name: 'SessionStateError', message: 'GPU lost' } } });
    await result;
  });

  it('a synchronous transfer error rejects only that call and leaves the client usable', async () => {
    const { port, listeners } = portHarness();
    vi.mocked(port.postMessage).mockImplementationOnce(() => { throw new Error('transfer failed'); });
    const client = SessionClient.attach(port);
    await expect(client.getParams()).rejects.toThrow('transfer failed');
    const result = client.getDiagnostics();
    listeners.get('message')!({ data: { id: 2, ok: true, result: { iirPrecisionOk: true } } });
    expect(await result).toEqual({ iirPrecisionOk: true });
  });
});
