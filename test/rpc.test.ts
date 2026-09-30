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
import type { ExportFormat, RenderResult } from '../src/session/session';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeImage, DecodeError } from '../src/io';
import type { ServeOptions } from '../src/session/worker';

/** Adaptor `MessagePort` Node ke bentuk DOM (`addEventListener` + `event.data`). */
function domPort(port: NodeMessagePort): MessagePortLike {
  return {
    postMessage: (msg, transfer) => port.postMessage(msg, transfer as never),
    addEventListener: (type, listener) => { if (type === 'message') port.on('message', (data) => listener({ data })); },
    start: () => port.start(),
  };
}

const ports: NodeMessagePort[] = [];
afterEach(() => {
  for (const p of ports.splice(0)) p.close();
});

let lastInit: unknown;

async function connect(fake: SessionLike, options?: ServeOptions): Promise<SessionClient> {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  serveSession(
    domPort(port2),
    async (init) => {
      lastInit = init;
      return fake;
    },
    options,
  );
  return SessionClient.connect(domPort(port1), { assetsBaseUrl: '/data' });
}

class FakeSession implements SessionLike {
  close() {}
  stageOpen(): Promise<never> { return Promise.reject(new Error('unused')); }
  commitOpen() {}
  finishOpen() {}
  discardOpen() {}
  calls: Array<[string, unknown[]]> = [];
  renderDelays: number[] = [];
  lastRgb: Float32Array | undefined;
  open(...args: unknown[]) {
    this.calls.push(['open', args]);
  }
  depth: { width: number; height: number; data: Float32Array } | null = null;
  setDepthMap(map: { width: number; height: number; data: Float32Array } | null) {
    this.calls.push(['setDepthMap', [map ? [map.width, map.height, map.data.length] : null]]);
    this.depth = map;
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
  lastFullSize() {
    return { width: 4, height: 3 };
  }
  async prewarm(): Promise<void> {
    this.calls.push(['prewarm', []]);
  }
  getDiagnostics() {
    return { iirPrecisionOk: false, iirMaxAbsError: 3e-4 };
  }
  async exportCube(size: number): Promise<string> {
    return `LUT_3D_SIZE ${size}\n`;
  }
  async renderExport(longEdge?: number) {
    this.calls.push(['renderExport', [longEdge]]);
    return { width: longEdge ?? 4, height: 3 };
  }
  async exportFormats(): Promise<ExportFormat[]> {
    return ['png8', 'png16', 'tiff16', 'jpeg'];
  }
  async exportImage(format: ExportFormat, options?: { longEdge?: number; quality?: number }): Promise<Uint8Array> {
    this.calls.push(['exportImage', options === undefined ? [format] : [format, options]]);
    return new TextEncoder().encode(format);
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
    expect(await client.getDiagnostics()).toEqual({ iirPrecisionOk: false, iirMaxAbsError: 3e-4 });
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

  it('prewarm diteruskan ke Session', async () => {
    const fake = new FakeSession();
    const client = await connect(fake);
    await client.prewarm();
    expect(fake.calls).toContainEqual(['prewarm', []]);
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

describe('RPC exportImage dan decode', () => {
  it('exportImage meneruskan format dan mengembalikan Uint8Array', async () => {
    const fake = new FakeSession();
    const client = await connect(fake);
    const bytes = await client.exportImage('tiff16');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toBe('tiff16');
    expect(fake.calls).toEqual([['exportImage', ['tiff16']]]);
  });

  it('setDepthMap mentransfer data peta kedalaman', async () => {
    const fake = new FakeSession();
    const client = await connect(fake);
    const data = new Float32Array([0, 0.5, 1, 1.5, 0.25, 0.75]);
    await client.setDepthMap({ width: 3, height: 2, data });
    expect(data.length).toBe(0); // ter-detach: ditransfer, bukan disalin
    expect(fake.depth?.data).toEqual(new Float32Array([0, 0.5, 1, 1.5, 0.25, 0.75]));
    await client.setDepthMap(null);
    expect(fake.calls).toEqual([['setDepthMap', [[3, 2, 6]]], ['setDepthMap', [null]]]);
  });

  it('renderExport, exportFormats, dan opsi ekspor diteruskan apa adanya', async () => {
    const fake = new FakeSession();
    const client = await connect(fake);
    expect(await client.renderExport(2048)).toEqual({ width: 2048, height: 3 });
    expect(await client.exportFormats()).toEqual(['png8', 'png16', 'tiff16', 'jpeg']);
    await client.exportImage('jpeg', { longEdge: 2048, quality: 0.8 });
    expect(fake.calls).toEqual([
      ['renderExport', [2048]],
      ['exportImage', ['jpeg', { longEdge: 2048, quality: 0.8 }]],
    ]);
  });

  it('decode di worker sama dengan decode langsung, dan tidak menunggu init', async () => {
    const png = new Uint8Array(readFileSync(join('test', 'fixtures', 'io', 'png_rgb16', 'input.png')));
    const direct = await decodeImage(png, 'a.png');
    const { port1, port2 } = new MessageChannel();
    ports.push(port1, port2);
    // Factory yang tidak pernah selesai: decode tetap harus dijawab.
    serveSession(domPort(port2), () => new Promise<SessionLike>(() => {}));
    void SessionClient.connect(domPort(port1), { assetsBaseUrl: '/data' });
    // `connect` tidak pernah selesai, jadi decode dikirim lewat port mentah dengan id bebas.
    const raw = domPort(port1);
    const answer = new Promise<unknown>((resolve) => raw.addEventListener('message', (e) => {
      const data = e.data as { id: number; result?: unknown };
      if (data.id === 99) resolve(data.result);
    }));
    raw.postMessage({ id: 99, method: 'decode', args: [png.slice(), 'a.png'] });
    const viaWorker = (await answer) as typeof direct;
    expect(viaWorker.width).toBe(direct.width);
    expect(viaWorker.source).toEqual(direct.source);
    expect(Array.from(viaWorker.rgba)).toEqual(Array.from(direct.rgba));
  });

  it('attach: decode lewat client sebelum init selesai, lalu init', async () => {
    const { port1, port2 } = new MessageChannel();
    ports.push(port1, port2);
    let release: (s: SessionLike) => void = () => {};
    serveSession(domPort(port2), () => new Promise<SessionLike>((r) => { release = r; }));
    const client = SessionClient.attach(domPort(port1));
    const initDone = client.init({ assetsBaseUrl: '/data' });
    const png = new Uint8Array(readFileSync(join('test', 'fixtures', 'io', 'png_gray8', 'input.png')));
    const image = await client.decode(png, 'g.png');
    expect(image.source.format).toBe('png');
    release(new FakeSession());
    await initDone;
    expect(await client.exportCube(9)).toBe('LUT_3D_SIZE 9\n');
  });

  it('decode lewat client mentransfer bytes dan memulihkan DecodeError', async () => {
    const client = await connect(new FakeSession());
    const png = new Uint8Array(readFileSync(join('test', 'fixtures', 'io', 'png_rgb8', 'input.png')));
    const image = await client.decode(png, 'x.png');
    expect(png.byteLength).toBe(0); // ter-transfer
    expect(image.source).toEqual({ format: 'png', bitDepth: 8, name: 'x.png' });
    expect(image.rgba).toBeInstanceOf(Float32Array);

    const broken = new Uint8Array(readFileSync(join('test', 'fixtures', 'io', 'png_rgb8', 'input.png'))).subarray(0, 100);
    const err = (await client.decode(broken.slice()).catch((e: unknown) => e)) as DecodeError;
    expect(err).toBeInstanceOf(DecodeError);
    expect(err.format).toBe('png');
    expect(err.reason.length).toBeGreaterThan(0);
  });

  it('decoder bisa disuntik (mis. wasmBinary LibRaw di Node)', async () => {
    const calls: Array<string | undefined> = [];
    const client = await connect(new FakeSession(), {
      decode: async (bytes, name) => {
        calls.push(name);
        return decodeImage(bytes, name);
      },
    });
    const png = new Uint8Array(readFileSync(join('test', 'fixtures', 'io', 'png_gray8', 'input.png')));
    await client.decode(png, 'g.png');
    expect(calls).toEqual(['g.png']);
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
