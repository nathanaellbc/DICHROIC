/**
 * Proyek: tiap foto yang dibuka menjadi proyek yang tersimpan otomatis di
 * perangkat (resep, penghapusan objek, thumbnail, berkas asli) dan bisa
 * dibuka lagi dari Recent di layar Start. Bebas React, seperti `engine`:
 * diamati lewat `subscribe`/`getState`.
 */
import type { RenderParams } from '../../params/renderParams';
import { engine } from '../engine/engine';
import type { EngineState, OpenRestore, SavedRemoval } from '../engine/engine';
import type { Frame } from '../engine/display';
import { IndexedDbProjectStore, MemoryProjectStore, isQuotaError } from './store';
import type { ProjectRecord, ProjectStore } from './store';

export interface ProjectCard {
  id: string;
  name: string;
  fileName: string;
  updatedAt: number;
  params: RenderParams;
  width: number;
  height: number;
  /** URL objek thumbnail, bila sudah ada. */
  thumb?: string;
  /** Berkas asli tidak tersimpan di perangkat: perlu dipilih ulang. */
  missing: boolean;
}

export interface ProjectsState {
  loaded: boolean;
  /** Terbaru di depan. */
  list: ProjectCard[];
  currentId?: string;
  /** Proyek yang baru dihapus, selama Undo masih bisa. */
  deleted?: { id: string; name: string };
  /** Pesan singkat untuk toast (mis. proyek lama dilepas karena kuota). */
  notice?: string;
}

/** Bagian `engine` yang dipakai proyek (diganti tiruan di test). */
export interface ProjectEngine {
  getState(): EngineState;
  subscribe(listener: () => void): () => void;
  openFile(file: File, restore?: OpenRestore): Promise<boolean>;
  closePhoto(): void;
  readonly removals: readonly SavedRemoval[];
}

/** Jeda autosave setelah perubahan terakhir. */
export const SAVE_DELAY_MS = 800;
/** Lama Undo setelah menghapus proyek. */
export const UNDO_MS = 5000;
const THUMB_EDGE = 640;

type Listener = () => void;

/** Thumbnail JPEG dari pratinjau yang tampil (sisi panjang 640 px). */
export async function frameThumbnail(frame: Frame): Promise<Blob | undefined> {
  if (typeof document === 'undefined') return undefined;
  const source = document.createElement('canvas');
  source.width = frame.width;
  source.height = frame.height;
  const ctx = source.getContext('2d', { colorSpace: frame.colorSpace });
  if (!ctx) return undefined;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height, { colorSpace: frame.colorSpace }), 0, 0);
  const scale = Math.min(1, THUMB_EDGE / Math.max(frame.width, frame.height));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(frame.width * scale));
  out.height = Math.max(1, Math.round(frame.height * scale));
  const octx = out.getContext('2d', { colorSpace: frame.colorSpace });
  if (!octx) return undefined;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(source, 0, 0, out.width, out.height);
  return new Promise((resolve) => out.toBlob((blob) => resolve(blob ?? undefined), 'image/jpeg', 0.82));
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '') || fileName;
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class Projects {
  #state: ProjectsState = { loaded: false, list: [] };
  readonly #listeners = new Set<Listener>();
  readonly #records = new Map<string, ProjectRecord>();
  readonly #thumbs = new Map<string, string>();
  #loading: Promise<void> | undefined;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #saving: Promise<void> = Promise.resolve();
  #undoTimer: ReturnType<typeof setTimeout> | undefined;
  #pendingDelete: ProjectRecord | undefined;
  /** Yang terakhir tersimpan untuk proyek terbuka. */
  #saved: { params?: RenderParams; retouches: number; frame?: Frame } = { retouches: 0 };
  #persistAsked = false;
  /** Proyek yang fotonya sedang dipilih ulang (pemilih berkas dibuka untuknya). */
  #relinkId: string | undefined;

  constructor(
    private readonly engine: ProjectEngine,
    private readonly store: ProjectStore,
    private readonly thumbnail: (frame: Frame) => Promise<Blob | undefined> = frameThumbnail,
    private readonly objectUrl: (blob: Blob) => string = (blob) => URL.createObjectURL(blob),
  ) {}

  getState = (): ProjectsState => this.#state;

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(patch: Partial<ProjectsState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  #card(record: ProjectRecord): ProjectCard {
    return {
      id: record.id, name: record.name, fileName: record.fileName, updatedAt: record.updatedAt,
      params: record.params, width: record.width, height: record.height,
      thumb: this.#thumbs.get(record.id), missing: !record.hasFile,
    };
  }

  #publish(): void {
    const list = [...this.#records.values()]
      .filter((r) => r.id !== this.#pendingDelete?.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((r) => this.#card(r));
    this.#set({ list });
  }

  /** Muat daftar sekali (dipanggil saat app mulai). */
  load(): Promise<void> {
    this.#loading ??= (async () => {
      // Autosave mengikuti engine sejak daftar dimuat (saat app mulai).
      this.engine.subscribe(() => this.#onEngine());
      try {
        for (const record of await this.store.list()) this.#records.set(record.id, record);
        await Promise.all([...this.#records.keys()].map(async (id) => {
          const thumb = await this.store.thumb(id).catch(() => undefined);
          if (thumb) this.#thumbs.set(id, this.objectUrl(thumb));
        }));
      } catch {
        // Penyimpanan tidak tersedia (mis. mode privat): daftar kosong.
      }
      this.#set({ loaded: true });
      this.#publish();
    })();
    return this.#loading;
  }

  dismissNotice(): void {
    if (this.#state.notice) this.#set({ notice: undefined });
  }

  /**
   * Berkas yang dipilih atau dijatuhkan. Berkas yang sama dengan proyek yang
   * ada membuka proyek itu (resep dan penghapusan objeknya); berkas baru
   * menjadi proyek baru.
   */
  async openFile(file: File): Promise<void> {
    const relinkId = this.#relinkId;
    this.#relinkId = undefined;
    if (relinkId && this.#records.has(relinkId)) return this.relink(relinkId, file);
    await this.load();
    await this.flush();
    const existing = [...this.#records.values()].find((r) =>
      r.id !== this.#pendingDelete?.id && r.fileName === file.name && r.fileSize === file.size && r.fileModified === file.lastModified);
    if (existing) {
      await this.#openRecord(existing, file);
      return;
    }
    this.#set({ currentId: undefined });
    if (!(await this.engine.openFile(file))) return;
    const state = this.engine.getState();
    const now = Date.now();
    const record: ProjectRecord = {
      id: newId(), name: baseName(file.name), fileName: file.name, fileSize: file.size, fileModified: file.lastModified,
      width: state.frame?.width ?? 0, height: state.frame?.height ?? 0,
      createdAt: now, updatedAt: now, params: state.params, hasFile: false, removals: 0,
    };
    this.#records.set(record.id, record);
    this.#saved = { params: state.params, retouches: 0 };
    this.#set({ currentId: record.id });
    this.#publish();
    await this.#storeRecord(record);
    record.hasFile = await this.#storeFile(record.id, file);
    await this.#storeRecord(record);
    this.#publish();
    this.#scheduleSave();
  }

  /** Buka proyek dari Recent. `false` bila foto aslinya tidak ada di perangkat. */
  async open(id: string): Promise<boolean> {
    await this.load();
    const record = this.#records.get(id);
    if (!record) return false;
    const file = record.hasFile ? await this.store.file(id).catch(() => undefined) : undefined;
    if (!file) {
      if (record.hasFile) {
        record.hasFile = false;
        await this.#storeRecord(record);
        this.#publish();
      }
      return false;
    }
    await this.flush();
    await this.#openRecord(record, file);
    return true;
  }

  /** Berkas berikutnya dari pemilih menggantikan foto asli proyek ini (`undefined`: batal). */
  requestRelink(id: string | undefined): void {
    this.#relinkId = id;
  }

  /** Foto asli hilang: berkas yang dipilih ulang menggantikannya, resep tetap. */
  async relink(id: string, file: File): Promise<void> {
    const record = this.#records.get(id);
    if (!record) return this.openFile(file);
    await this.flush();
    await this.#openRecord(record, file);
    if (this.#state.currentId !== id) return;
    record.fileName = file.name;
    record.fileSize = file.size;
    record.fileModified = file.lastModified;
    record.hasFile = await this.#storeFile(id, file);
    await this.#storeRecord(record);
    this.#publish();
  }

  async #openRecord(record: ProjectRecord, file: File): Promise<void> {
    this.#set({ currentId: undefined });
    const removals = await this.store.removals(record.id).catch(() => [] as SavedRemoval[]);
    if (!(await this.engine.openFile(file, { params: record.params, removals }))) return;
    const state = this.engine.getState();
    this.#saved = { params: state.params, retouches: state.retouches, frame: undefined };
    record.updatedAt = Date.now();
    this.#set({ currentId: record.id });
    this.#publish();
    await this.#storeRecord(record);
    // Thumbnail mengikuti render pertama proyek ini.
    this.#scheduleSave();
  }

  async rename(id: string, name: string): Promise<void> {
    const record = this.#records.get(id);
    const trimmed = name.trim();
    if (!record || !trimmed || trimmed === record.name) return;
    record.name = trimmed.slice(0, 120);
    this.#publish();
    await this.#storeRecord(record);
  }

  async duplicate(id: string): Promise<void> {
    const record = this.#records.get(id);
    if (!record) return;
    const copy: ProjectRecord = { ...record, id: newId(), name: `${record.name} copy`, createdAt: Date.now(), updatedAt: Date.now() };
    const [file, thumb, removals] = await Promise.all([
      this.store.file(id).catch(() => undefined), this.store.thumb(id).catch(() => undefined), this.store.removals(id).catch(() => []),
    ]);
    copy.hasFile = file ? await this.#storeFile(copy.id, file) : false;
    if (thumb) {
      await this.store.putThumb(copy.id, thumb).catch(() => {});
      this.#thumbs.set(copy.id, this.objectUrl(thumb));
    }
    if (removals.length) await this.store.putRemovals(copy.id, removals).catch(() => {});
    this.#records.set(copy.id, copy);
    await this.#storeRecord(copy);
    this.#publish();
  }

  /** Hapus dari daftar sekarang; dari perangkat setelah Undo lewat. */
  remove(id: string): void {
    const record = this.#records.get(id);
    if (!record) return;
    this.#commitDelete();
    this.#pendingDelete = record;
    if (this.#state.currentId === id) this.#set({ currentId: undefined });
    this.#set({ deleted: { id, name: record.name } });
    this.#publish();
    this.#undoTimer = setTimeout(() => this.#commitDelete(), UNDO_MS);
  }

  undoRemove(): void {
    if (!this.#pendingDelete) return;
    clearTimeout(this.#undoTimer);
    this.#pendingDelete = undefined;
    this.#set({ deleted: undefined });
    this.#publish();
  }

  #commitDelete(): void {
    clearTimeout(this.#undoTimer);
    const record = this.#pendingDelete;
    if (!record) return;
    this.#pendingDelete = undefined;
    this.#records.delete(record.id);
    const url = this.#thumbs.get(record.id);
    if (url) URL.revokeObjectURL?.(url);
    this.#thumbs.delete(record.id);
    void this.store.remove(record.id).catch(() => {});
    this.#set({ deleted: undefined });
    this.#publish();
  }

  /** Tutup foto: perubahan terakhir disimpan dulu, proyek tetap di Recent. */
  async close(): Promise<void> {
    await this.flush();
    this.#set({ currentId: undefined });
    this.engine.closePhoto();
  }

  /** Simpan perubahan yang tertunda sekarang (mis. sebelum menutup foto). */
  flush(): Promise<void> {
    if (this.#saveTimer !== undefined) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = undefined;
      this.#saving = this.#saving.then(() => this.#save());
    }
    return this.#saving;
  }

  #onEngine(): void {
    const state = this.engine.getState();
    const id = this.#state.currentId;
    if (!id) return;
    // Foto ditutup atau diganti: proyek ini selesai.
    if (state.phase === 'idle' && !state.fileName) {
      void this.flush();
      this.#set({ currentId: undefined });
      return;
    }
    if (state.phase !== 'editing') return;
    const changed = state.params !== this.#saved.params || state.retouches !== this.#saved.retouches
      || (!state.rendering && state.frame !== this.#saved.frame);
    if (changed) this.#scheduleSave();
  }

  #scheduleSave(): void {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      this.#saving = this.#saving.then(() => this.#save());
    }, SAVE_DELAY_MS);
  }

  async #save(): Promise<void> {
    const id = this.#state.currentId;
    const record = id ? this.#records.get(id) : undefined;
    const state = this.engine.getState();
    if (!record || state.phase !== 'editing') return;
    const paramsChanged = state.params !== this.#saved.params;
    const removalsChanged = state.retouches !== this.#saved.retouches;
    const frame = !state.rendering ? state.frame : undefined;
    const thumbChanged = !!frame && frame !== this.#saved.frame;
    if (!paramsChanged && !removalsChanged && !thumbChanged) return;
    if (removalsChanged) {
      await this.store.putRemovals(record.id, this.engine.removals).catch(() => {});
      record.removals = this.engine.removals.length;
    }
    if (thumbChanged && frame) {
      const blob = await this.thumbnail(frame).catch(() => undefined);
      if (blob) {
        await this.store.putThumb(record.id, blob).catch(() => {});
        const old = this.#thumbs.get(record.id);
        if (old) URL.revokeObjectURL?.(old);
        this.#thumbs.set(record.id, this.objectUrl(blob));
      }
    }
    record.params = state.params;
    record.width = frame?.width ?? record.width;
    record.height = frame?.height ?? record.height;
    if (paramsChanged || removalsChanged) record.updatedAt = Date.now();
    this.#saved = { params: state.params, retouches: state.retouches, frame: frame ?? this.#saved.frame };
    await this.#storeRecord(record);
    this.#publish();
  }

  async #storeRecord(record: ProjectRecord): Promise<void> {
    await this.store.put({ ...record }).catch(() => {});
  }

  /**
   * Simpan berkas asli. Kuota penuh: proyek tertua (bukan yang terbuka)
   * dilepas lalu dicoba sekali lagi; tetap gagal = proyek tanpa berkas.
   */
  async #storeFile(id: string, file: File): Promise<boolean> {
    this.#askPersist();
    try {
      await this.store.putFile(id, file);
      return true;
    } catch (error) {
      if (!isQuotaError(error)) return false;
    }
    const oldest = [...this.#records.values()]
      .filter((r) => r.id !== id && r.id !== this.#state.currentId && r.hasFile)
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!oldest) return false;
    await this.store.remove(oldest.id).catch(() => {});
    this.#records.delete(oldest.id);
    this.#thumbs.delete(oldest.id);
    this.#set({ notice: `Removed “${oldest.name}” to free space on this device.` });
    this.#publish();
    try {
      await this.store.putFile(id, file);
      return true;
    } catch {
      return false;
    }
  }

  /** Minta browser tidak membersihkan penyimpanan proyek otomatis. */
  #askPersist(): void {
    if (this.#persistAsked) return;
    this.#persistAsked = true;
    void globalThis.navigator?.storage?.persist?.().catch(() => false);
  }
}

function createStore(): ProjectStore {
  try {
    if (typeof indexedDB !== 'undefined') return new IndexedDbProjectStore();
  } catch {
    // Akses IndexedDB diblokir.
  }
  return new MemoryProjectStore();
}

export const projects = new Projects(engine, createStore());
