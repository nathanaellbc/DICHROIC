import { describe, it, expect, afterEach } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import type { MessagePort as NodeMessagePort } from 'node:worker_threads';
import { SessionClient } from '../src/session/client';
import { serveSession } from '../src/session/worker';
import type { MessagePortLike, SessionLike } from '../src/session/protocol';
import { transferablesOf } from '../src/session/protocol';
import { UnverifiedParameterError } from '../src/params/registry';
import { RenderSupersededError } from '../src/session/errors';
import { BASELINE_RENDER_PARAMS } from '../src/params/renderParams';
import type { RenderParams } from '../src/params/renderParams';
import type { RenderResult } from '../src/session/session';

/** Adaptor `MessagePort` Node ke bentuk DOM (`addEventListener` + `event.data`). */
function domPort(port: NodeMessagePort): MessagePortLike {
  return {
    postMessage: (msg, transfer) => port.postMessage(msg, transfer as never),
    addEventListener: (_type, listener) => port.on('message', (data) => listener({ data })),
    start: () => port.start(),
  };
}

const ports: NodeMessagePort[] = [];
afterEach(() => {
  for (const p of ports.splice(0)) p.close();
});

let lastInit: unknown;

async function connect(fake: SessionLike): Promise<SessionClient> {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  serveSession(domPort(port2), async (init) => {
    lastInit = init;
    return fake;
  });
  return SessionClient.connect(domPort(port1), { assetsBaseUrl: '/data' });
}

class FakeSession implements SessionLike {
  calls: Array<[string, unknown[]]> = [];
  renderDelays: number[] = [];
  lastRgb: Float32Array | undefined;
  open(...args: unknown[]) {
    this.calls.push(['open', args]);
  }
  setParams(patch: Partial<RenderParams>) {
    this.calls.push(['setParams', [patch]]);
    if (patch.film) throw new UnverifiedParameterError('film', patch.film, 'kodak_portra_400');
  }
  getParams(): RenderParams {
    return { ...BASELINE_RENDER_PARAMS };
  }
  async render(quality: 'full' | 'preview'): Promise<RenderResult> {
    const delay = this.renderDelays.shift() ?? 0;
    await new Promise((r) => setTimeout(r, delay));
    if (delay < 0) throw new RenderSupersededError();
    this.lastRgb = Float32Array.of(delay, 0.5, 0.25);
    return { width: 1, height: 1, rgb: this.lastRgb, quality, paramsVersion: delay };
  }
  async exportCube(size: number): Promise<string> {
    return `LUT_3D_SIZE ${size}\n`;
  }
  dispose() {
    this.calls.push(['dispose', []]);
  }
}

describe('RPC Session', () => {
  it('meneruskan argumen apa adanya', async () => {
    const fake = new FakeSession();
    const client = await connect(fake);
    await client.setParams({ grainEnabled: false, glareEnabled: false });
    expect(fake.calls).toEqual([['setParams', [{ grainEnabled: false, glareEnabled: false }]]]);
    expect(await client.getParams()).toEqual(BASELINE_RENDER_PARAMS);
    expect(await client.exportCube(33)).toBe('LUT_3D_SIZE 33\n');
  });

  it('mengirim init (URL aset) ke factory sebelum panggilan pertama', async () => {
    await connect(new FakeSession());
    expect(lastInit).toEqual({ assetsBaseUrl: '/data' });
  });

  it('mentransfer SALINAN: buffer hasil di sisi Session (cache) tidak ter-detach', async () => {
    const fake = new FakeSession();
    const client = await connect(fake);
    await client.render('full');
    expect(fake.lastRgb!.length).toBe(3);
    expect(Array.from(fake.lastRgb!)).toEqual([0, 0.5, 0.25]);
  });

  it('mengembalikan Float32Array hasil render utuh', async () => {
    const client = await connect(new FakeSession());
    const result = await client.render('full');
    expect(result.rgb).toBeInstanceOf(Float32Array);
    expect(Array.from(result.rgb)).toEqual([0, 0.5, 0.25]);
  });

  it('memulihkan kelas galat dan field-nya di sisi client', async () => {
    const client = await connect(new FakeSession());
    const err = await client.setParams({ film: 'kodak_gold_200' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnverifiedParameterError);
    expect((err as UnverifiedParameterError).field).toBe('film');
    expect((err as UnverifiedParameterError).value).toBe('kodak_gold_200');
  });

  it('memulihkan RenderSupersededError', async () => {
    const fake = new FakeSession();
    fake.renderDelays = [-1];
    const client = await connect(fake);
    await expect(client.render('preview')).rejects.toBeInstanceOf(RenderSupersededError);
  });

  it('jawaban yang datang terbalik tetap sampai ke permintaan yang benar', async () => {
    const fake = new FakeSession();
    fake.renderDelays = [40, 1];
    const client = await connect(fake);
    const [slow, fast] = await Promise.all([client.render('full'), client.render('preview')]);
    expect(slow.paramsVersion).toBe(40);
    expect(slow.quality).toBe('full');
    expect(fast.paramsVersion).toBe(1);
    expect(fast.quality).toBe('preview');
  });
});

describe('transferablesOf', () => {
  it('mengumpulkan buffer dari Float32Array yang bersarang, tanpa duplikat', () => {
    const rgb = new Float32Array(3);
    const found = transferablesOf({ result: { rgb, again: rgb }, other: [new Uint8Array(2)] });
    expect(found).toHaveLength(2);
    expect(found).toContain(rgb.buffer);
  });
});
