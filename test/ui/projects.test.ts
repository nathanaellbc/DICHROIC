import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BASELINE_RENDER_PARAMS } from '../../src/params/renderParams';
import type { RenderParams } from '../../src/params/renderParams';
import type { EngineState, OpenRestore, SavedRemoval } from '../../src/ui/engine/engine';
import { Projects, SAVE_DELAY_MS, UNDO_MS } from '../../src/ui/projects/projects';
import type { ProjectEngine } from '../../src/ui/projects/projects';
import { MemoryProjectStore } from '../../src/ui/projects/store';
import { dayGroup, recipeText, relativeTime } from '../../src/ui/projects/format';

class FakeEngine implements ProjectEngine {
  state = {
    phase: 'idle', params: { ...BASELINE_RENDER_PARAMS }, rendering: false, retouches: 0,
  } as unknown as EngineState;
  removals: SavedRemoval[] = [];
  opened: Array<{ file: File; restore?: OpenRestore }> = [];
  fail = false;
  readonly listeners = new Set<() => void>();
  getState = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  set(patch: Partial<EngineState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
  async openFile(file: File, restore?: OpenRestore): Promise<boolean> {
    this.opened.push({ file, restore });
    if (this.fail) return false;
    this.removals = restore ? [...restore.removals] : [];
    this.set({
      phase: 'editing', fileName: file.name, params: restore ? { ...this.state.params, ...restore.params } : this.state.params,
      frame: { width: 40, height: 30, pixels: new Uint8ClampedArray(40 * 30 * 4), colorSpace: 'srgb' }, retouches: this.removals.length,
    });
    return true;
  }
  closePhoto() { this.set({ phase: 'idle', fileName: undefined, frame: undefined }); }
}

function photo(name: string, size = 10, modified = 1): File {
  return new File([new Uint8Array(size)], name, { lastModified: modified });
}

function setup() {
  const engine = new FakeEngine();
  const store = new MemoryProjectStore();
  let n = 0;
  const projects = new Projects(engine, store, async () => new Blob(['thumb']), () => `blob:thumb-${++n}`);
  return { engine, store, projects };
}

const settle = async () => {
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS + 10);
  await vi.runOnlyPendingTimersAsync();
};

describe('Projects', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('turns an opened photo into a saved project with its file and thumbnail', async () => {
    const { projects, store } = setup();
    await projects.openFile(photo('IMG_2041.HEIC'));
    await settle();
    const [card] = projects.getState().list;
    expect(card?.name).toBe('IMG_2041');
    expect(card?.missing).toBe(false);
    expect(card?.thumb).toMatch(/^blob:thumb/);
    expect(projects.getState().currentId).toBe(card?.id);
    expect(await store.file(card!.id)).toBeInstanceOf(File);
  });

  it('autosaves the recipe after edits and keeps the newest project first', async () => {
    const { projects, engine, store } = setup();
    await projects.openFile(photo('a.jpg'));
    await settle();
    await projects.openFile(photo('b.jpg'));
    await settle();
    const edited: RenderParams = { ...engine.state.params, film: 'kodak_gold_200' };
    engine.set({ params: edited });
    await settle();
    const records = await store.list();
    const b = records.find((r) => r.fileName === 'b.jpg');
    expect(b?.params.film).toBe('kodak_gold_200');
    expect(projects.getState().list.map((c) => c.fileName)).toEqual(['b.jpg', 'a.jpg']);
  });

  it('reopens the same file as its existing project with the saved recipe and removals', async () => {
    const { projects, engine, store } = setup();
    const file = photo('same.jpg', 20, 5);
    await projects.openFile(file);
    await settle();
    const id = projects.getState().currentId!;
    const removal = { crop: { revision: 1 } as never, output: new Float32Array(3) };
    engine.removals = [removal];
    engine.set({ params: { ...engine.state.params, film: 'fujifilm_c200' }, retouches: 1 });
    await settle();
    expect((await store.removals(id)).length).toBe(1);
    await projects.close();
    await projects.openFile(photo('same.jpg', 20, 5));
    expect(projects.getState().list.length).toBe(1);
    const last = engine.opened.at(-1)!;
    expect(last.restore?.params.film).toBe('fujifilm_c200');
    expect(last.restore?.removals.length).toBe(1);
    expect(projects.getState().currentId).toBe(id);
  });

  it('opens a project from Recent, or reports a missing original', async () => {
    const { projects, store, engine } = setup();
    await projects.openFile(photo('x.jpg'));
    await settle();
    const id = projects.getState().currentId!;
    await projects.close();
    expect(await projects.open(id)).toBe(true);
    expect(engine.opened.at(-1)?.restore).toBeDefined();
    await projects.close();
    store.blobs.delete(`file:${id}`);
    expect(await projects.open(id)).toBe(false);
    expect(projects.getState().list[0]?.missing).toBe(true);
  });

  it('relinks a missing original from the next picked file', async () => {
    const { projects, store } = setup();
    await projects.openFile(photo('lost.jpg'));
    await settle();
    const id = projects.getState().currentId!;
    await projects.close();
    store.blobs.delete(`file:${id}`);
    await projects.open(id);
    projects.requestRelink(id);
    await projects.openFile(photo('found.jpg', 12));
    const card = projects.getState().list.find((c) => c.id === id);
    expect(projects.getState().list.length).toBe(1);
    expect(card?.missing).toBe(false);
    expect(card?.fileName).toBe('found.jpg');
  });

  it('deletes with Undo, and from storage once Undo has passed', async () => {
    const { projects, store } = setup();
    await projects.openFile(photo('keep.jpg'));
    await settle();
    const id = projects.getState().currentId!;
    projects.remove(id);
    expect(projects.getState().list.length).toBe(0);
    expect(projects.getState().deleted?.name).toBe('keep');
    projects.undoRemove();
    expect(projects.getState().list.length).toBe(1);
    projects.remove(id);
    await vi.advanceTimersByTimeAsync(UNDO_MS + 10);
    expect(projects.getState().deleted).toBeUndefined();
    expect(store.records.has(id)).toBe(false);
  });

  it('frees the oldest project when the device runs out of space', async () => {
    const { projects, store } = setup();
    store.quotaBytes = 25;
    await projects.openFile(photo('old.jpg', 10));
    await settle();
    await projects.close();
    await projects.openFile(photo('new.jpg', 20));
    await settle();
    const names = projects.getState().list.map((c) => c.fileName);
    expect(names).toEqual(['new.jpg']);
    expect(projects.getState().list[0]?.missing).toBe(false);
    expect(projects.getState().notice).toMatch(/old/);
  });

  it('renames and duplicates', async () => {
    const { projects } = setup();
    await projects.openFile(photo('d.jpg'));
    await settle();
    const id = projects.getState().currentId!;
    await projects.rename(id, '  Pantai sore  ');
    expect(projects.getState().list[0]?.name).toBe('Pantai sore');
    await projects.duplicate(id);
    expect(projects.getState().list.map((c) => c.name).sort()).toEqual(['Pantai sore', 'Pantai sore copy']);
  });

  it('saves pending edits before closing the photo', async () => {
    const { projects, engine, store } = setup();
    await projects.openFile(photo('c.jpg'));
    await settle();
    engine.set({ params: { ...engine.state.params, filmEnabled: false } });
    await projects.close();
    expect((await store.list())[0]?.params.filmEnabled).toBe(false);
    expect(engine.state.phase).toBe('idle');
  });

  it('does not create a project when opening fails', async () => {
    const { projects, engine } = setup();
    engine.fail = true;
    await projects.openFile(photo('bad.raw'));
    expect(projects.getState().list.length).toBe(0);
  });
});

describe('project text', () => {
  it('describes the recipe', () => {
    expect(recipeText({ ...BASELINE_RENDER_PARAMS, film: 'kodak_portra_400', filmEnabled: true, process: 'printSimulation', paper: 'kodak_portra_endura' })).toBe('Portra 400 → Portra Endura');
    expect(recipeText({ ...BASELINE_RENDER_PARAMS, filmEnabled: false, paper: 'kodak_portra_endura' })).toBe('Film Off · Neutral negative');
  });

  it('formats time and day groups', () => {
    const now = new Date(2026, 9, 15, 15, 0).getTime();
    expect(relativeTime(now - 30_000, now)).toBe('Just now');
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe('2 hours ago');
    expect(relativeTime(now - 86_400_000, now)).toBe('Yesterday');
    expect(dayGroup(now - 3_600_000, now)).toBe('Today');
    expect(dayGroup(now - 20 * 3_600_000, now)).toBe('Yesterday');
    expect(dayGroup(now - 40 * 86_400_000, now)).toBe('Earlier');
  });
});
