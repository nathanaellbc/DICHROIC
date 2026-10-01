import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { bootWorker, SERVER_FLAG } from '../src/session/worker';
import { serveSession } from '../src/session/server';
import type { MessagePortLike, SessionLike } from '../src/session/protocol';

/**
 * Entry worker `Session` (`src/session/worker.ts`). Regresi iPhone: Safari
 * mengevaluasi ulang entry worker yang di-import chunk decoder, memasang
 * server kedua tanpa `init` yang membalas `RPC "stageOpen" sebelum "init"`.
 */

/** Scope worker palsu: pesan masuk lewat `deliver`, balasan dicatat. */
function fakeScope() {
  const listeners = new Set<(event: { data?: unknown }) => void>();
  const replies: Array<{ id: number; ok: boolean; result?: unknown; error?: { message: string } }> = [];
  const scope: MessagePortLike & { [SERVER_FLAG]?: true } = {
    postMessage: (message) => replies.push(message as (typeof replies)[number]),
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const deliver = (data: unknown) => {
    for (const l of [...listeners]) l({ data });
  };
  return { scope, deliver, replies, listeners };
}

const fakeSession = (log: string[]): SessionLike =>
  ({
    setParams: (patch: unknown) => void log.push(`setParams ${JSON.stringify(patch)}`),
    stageOpen: async (id: number) => {
      log.push(`stageOpen ${id}`);
      return { id };
    },
  }) as unknown as SessionLike;

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('bootWorker', () => {
  it('pesan yang tiba selagi server dimuat ditampung dan dilayani berurutan', async () => {
    const { scope, deliver, replies, listeners } = fakeScope();
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    bootWorker(scope, async () => {
      await gate;
      return { startWorker: (s, backlog) => serveSession(s, async () => fakeSession(log), { backlog }) };
    });
    deliver({ id: 1, method: 'init', args: [{ assetsBaseUrl: 'x' }] });
    deliver({ id: 2, method: 'setParams', args: [{ exposure: 1 }] });
    deliver({ id: 3, method: 'stageOpen', args: [7] });
    expect(replies).toHaveLength(0);
    release();
    await settle();
    expect(replies.map((r) => [r.id, r.ok])).toEqual([[1, true], [2, true], [3, true]]);
    expect(log).toEqual(['setParams {"exposure":1}', 'stageOpen 7']);
    expect(listeners.size).toBe(1); // penampung dilepas, tinggal server
  });

  it('entry yang dievaluasi ulang tidak memasang server kedua (satu balasan per RPC)', async () => {
    const { scope, deliver, replies } = fakeScope();
    const load = async () => ({ startWorker: (s: MessagePortLike, backlog: ReadonlyArray<{ data?: unknown }>) => serveSession(s, async () => fakeSession([]), { backlog }) });
    expect(bootWorker(scope, load)).toBe(true);
    await settle();
    deliver({ id: 1, method: 'init', args: [{ assetsBaseUrl: 'x' }] });
    await settle();
    expect(bootWorker(scope, load)).toBe(false); // evaluasi kedua (Safari) setelah init
    await settle();
    deliver({ id: 2, method: 'stageOpen', args: [9] });
    await settle();
    expect(replies.filter((r) => r.id === 2)).toEqual([{ id: 2, ok: true, result: { id: 9 } }]);
  });

  it('modul server gagal dimuat: galat id 0 (client mematikan sesi), bukan diam', async () => {
    const { scope, replies } = fakeScope();
    bootWorker(scope, async () => {
      throw new Error('offline');
    });
    await settle();
    expect(replies).toEqual([{ id: 0, ok: false, error: { name: 'Error', message: 'The image worker failed to load: offline' } }]);
  });

  it('entry tanpa import statis bernilai (tidak bisa jadi chunk bersama yang di-import chunk lain)', () => {
    const src = readFileSync('src/session/worker.ts', 'utf8');
    const imports = src.split(/\r?\n/).filter((l) => /^\s*import\s/.test(l));
    expect(imports.every((l) => /^\s*import\s+type\s/.test(l)), imports.join('\n')).toBe(true);
  });
});
