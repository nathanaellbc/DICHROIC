/**
 * Penyimpanan proyek di perangkat (IndexedDB): metadata dan resep di
 * `projects`, berkas asli, thumbnail, dan penghapusan objek di `blobs`.
 * Tidak ada yang keluar dari perangkat. `MemoryProjectStore` untuk test.
 */
import type { RenderParams } from '../../params/renderParams';
import type { SavedRemoval } from '../engine/engine';

export interface ProjectRecord {
  id: string;
  /** Nama yang ditampilkan; awalnya nama berkas tanpa ekstensi, bisa diganti. */
  name: string;
  fileName: string;
  fileSize: number;
  fileModified: number;
  width: number;
  height: number;
  createdAt: number;
  updatedAt: number;
  params: RenderParams;
  /** Berkas asli tersimpan (gagal bila kuota penuh; proyek tetap ada). */
  hasFile: boolean;
  removals: number;
}

export interface ProjectStore {
  list(): Promise<ProjectRecord[]>;
  put(record: ProjectRecord): Promise<void>;
  remove(id: string): Promise<void>;
  putFile(id: string, file: File): Promise<void>;
  file(id: string): Promise<File | undefined>;
  putThumb(id: string, thumb: Blob): Promise<void>;
  thumb(id: string): Promise<Blob | undefined>;
  putRemovals(id: string, removals: readonly SavedRemoval[]): Promise<void>;
  removals(id: string): Promise<SavedRemoval[]>;
}

const DB_NAME = 'gamma.projects';
const DB_VERSION = 1;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Storage request failed.'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Storage transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new DOMException('Storage transaction aborted.', 'AbortError'));
  });
}

export class IndexedDbProjectStore implements ProjectStore {
  #db: Promise<IDBDatabase> | undefined;

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Project storage is unavailable.'));
    });
    return this.#db;
  }

  async #read<T>(store: 'projects' | 'blobs', key: string): Promise<T | undefined> {
    const db = await this.#open();
    return request(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
  }

  async #write(store: 'projects' | 'blobs', value: unknown, key?: string): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    await done(tx);
  }

  async list(): Promise<ProjectRecord[]> {
    const db = await this.#open();
    return request(db.transaction('projects').objectStore('projects').getAll()) as Promise<ProjectRecord[]>;
  }

  put(record: ProjectRecord): Promise<void> { return this.#write('projects', record); }

  async remove(id: string): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(['projects', 'blobs'], 'readwrite');
    tx.objectStore('projects').delete(id);
    for (const kind of ['file', 'thumb', 'removals']) tx.objectStore('blobs').delete(`${kind}:${id}`);
    await done(tx);
  }

  putFile(id: string, file: File): Promise<void> { return this.#write('blobs', file, `file:${id}`); }
  file(id: string): Promise<File | undefined> { return this.#read<File>('blobs', `file:${id}`); }
  putThumb(id: string, thumb: Blob): Promise<void> { return this.#write('blobs', thumb, `thumb:${id}`); }
  thumb(id: string): Promise<Blob | undefined> { return this.#read<Blob>('blobs', `thumb:${id}`); }
  putRemovals(id: string, removals: readonly SavedRemoval[]): Promise<void> { return this.#write('blobs', [...removals], `removals:${id}`); }
  async removals(id: string): Promise<SavedRemoval[]> { return (await this.#read<SavedRemoval[]>('blobs', `removals:${id}`)) ?? []; }
}

/** Untuk test dan bila IndexedDB tidak tersedia (proyek berlaku untuk sesi ini). */
export class MemoryProjectStore implements ProjectStore {
  readonly records = new Map<string, ProjectRecord>();
  readonly blobs = new Map<string, unknown>();
  /** Test: berkas lebih besar dari ini gagal seperti kuota penuh. */
  quotaBytes = Infinity;

  async list(): Promise<ProjectRecord[]> { return [...this.records.values()].map((r) => ({ ...r })); }
  async put(record: ProjectRecord): Promise<void> { this.records.set(record.id, { ...record }); }
  async remove(id: string): Promise<void> {
    this.records.delete(id);
    for (const kind of ['file', 'thumb', 'removals']) this.blobs.delete(`${kind}:${id}`);
  }
  async putFile(id: string, file: File): Promise<void> {
    const used = [...this.blobs.entries()].filter(([k]) => k.startsWith('file:')).reduce((n, [, f]) => n + (f as File).size, 0);
    if (used + file.size > this.quotaBytes) throw new DOMException('Quota exceeded', 'QuotaExceededError');
    this.blobs.set(`file:${id}`, file);
  }
  async file(id: string): Promise<File | undefined> { return this.blobs.get(`file:${id}`) as File | undefined; }
  async putThumb(id: string, thumb: Blob): Promise<void> { this.blobs.set(`thumb:${id}`, thumb); }
  async thumb(id: string): Promise<Blob | undefined> { return this.blobs.get(`thumb:${id}`) as Blob | undefined; }
  async putRemovals(id: string, removals: readonly SavedRemoval[]): Promise<void> { this.blobs.set(`removals:${id}`, [...removals]); }
  async removals(id: string): Promise<SavedRemoval[]> { return (this.blobs.get(`removals:${id}`) as SavedRemoval[] | undefined) ?? []; }
}

export function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'QuotaExceededError' || error.code === 22);
}
