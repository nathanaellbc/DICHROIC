/**
 * Jembatan UI <-> `Session` di Web Worker. Bebas React: state disimpan di sini
 * dan diamati lewat `subscribe`/`getState` (`useSyncExternalStore`).
 *
 * Alur buka berkas: decode di worker (boleh selagi engine masih disiapkan) ->
 * pratinjau "sebelum" dibuat di thread UI -> `open` (buffer ditransfer) ->
 * saran colour space input dari decoder -> render pratinjau pertama.
 *
 * Render dikoalesikan di sini (satu permintaan berjalan + satu penanda
 * "kotor"), jadi menggeser slider 60 kali per detik tidak membanjiri worker;
 * `Session` sendiri juga membuang permintaan yang tersalip.
 */
import { detectFormat } from '../../io/detect';
import { DecodeError } from '../../io/errors';
import type { DecodedImage } from '../../io/decoded';
import { BASELINE_RENDER_PARAMS } from '../../params/renderParams';
import type { RenderParams } from '../../params/renderParams';
import { SessionClient } from '../../session/client';
import { PREVIEW_MAX_LONG_EDGE } from '../../session/downscale';
import { RenderSupersededError } from '../../session/errors';
import type { ExportFormat } from '../../session/session';
import { suggestedInput } from '../model/tools';
import { canvasColorSpaceFor, originalFrame, rgbToPixels, type Frame } from './display';

export type EngineStatus = 'connecting' | 'ready' | 'unsupported' | 'failed';
export type Phase = 'idle' | 'opening' | 'editing';

export interface AppError {
  title: string;
  message: string;
}

export interface EngineState {
  engine: EngineStatus;
  phase: Phase;
  opening?: { name: string; stage: string };
  fileName?: string;
  params: RenderParams;
  /** Nilai "reset" untuk foto ini: baseline + saran input dari decoder. */
  defaults: RenderParams;
  frame?: Frame;
  original?: Frame;
  /** Render sedang berjalan (pratinjau masih menampilkan frame sebelumnya). */
  rendering: boolean;
  error?: AppError;
  /** `false` bila backend meruntuhkan aritmetika df64 (halation/DIR bisa meleset ~1e-3). */
  precisionOk: boolean;
}

type Listener = () => void;

const MIME: Record<ExportFormat, string> = { png8: 'image/png', png16: 'image/png', tiff16: 'image/tiff' };
const EXT: Record<ExportFormat, string> = { png8: 'png', png16: 'png', tiff16: 'tif' };

function baseName(name: string | undefined): string {
  return (name ?? 'photo').replace(/\.[^.]+$/, '') || 'photo';
}

export function describeError(error: unknown, fileName?: string): AppError {
  if (error instanceof DecodeError) {
    const title = fileName ? `Can’t Open “${fileName}”` : 'Can’t Open This File';
    if (error.format === 'unknown') {
      return { title, message: 'This file format isn’t supported. Export it as JPEG or TIFF, or open the camera’s original RAW file.' };
    }
    if (error.format === 'raw' && /COOP|cross-origin/i.test(error.reason)) {
      return { title, message: 'RAW files need this page to be served with cross-origin isolation. Open DICHROIC from its installed address.' };
    }
    return { title, message: `The ${error.format.toUpperCase()} file looks damaged, or uses a feature that isn’t supported yet.` };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { title: 'Something Went Wrong', message };
}

export class Engine {
  #state: EngineState = {
    engine: 'connecting',
    phase: 'idle',
    params: { ...BASELINE_RENDER_PARAMS },
    defaults: { ...BASELINE_RENDER_PARAMS },
    rendering: false,
    precisionOk: true,
  };
  readonly #listeners = new Set<Listener>();
  #client: SessionClient | undefined;
  #ready: Promise<void> | undefined;
  #openToken = 0;
  #inFlight = false;
  #dirty = false;

  getState = (): EngineState => this.#state;

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(patch: Partial<EngineState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  /** Menyalakan worker dan menyiapkan `Session` (aset, device WebGPU, self-test). */
  start(): void {
    if (this.#client) return;
    const worker = new Worker(new URL('../../session/worker.ts', import.meta.url), { type: 'module', name: 'dichroic-session' });
    const client = SessionClient.attach(worker);
    this.#client = client;
    const assetsBaseUrl = new URL(`${import.meta.env.BASE_URL}data`, window.location.href).href;
    this.#ready = client.init({ assetsBaseUrl }).then(
      async () => {
        const diagnostics = await client.getDiagnostics();
        this.#set({ engine: 'ready', precisionOk: diagnostics.iirPrecisionOk });
      },
      (error: unknown) => {
        const unsupported = error instanceof Error && error.name === 'WebGPUUnavailableError';
        this.#set({ engine: unsupported ? 'unsupported' : 'failed', error: unsupported ? undefined : describeError(error) });
        throw error;
      },
    );
    this.#ready.catch(() => {});
  }

  async openFile(file: File): Promise<void> {
    const client = this.#client;
    if (!client) return;
    const token = ++this.#openToken;
    const stillCurrent = () => token === this.#openToken;
    this.#set({ phase: 'opening', opening: { name: file.name, stage: 'Reading…' }, error: undefined });
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const format = detectFormat(bytes);
      if (!stillCurrent()) return;
      this.#set({ opening: { name: file.name, stage: format === 'raw' || format === 'unknown' ? 'Decoding RAW…' : 'Decoding…' } });
      const image: DecodedImage = await client.decode(bytes, file.name);
      if (!stillCurrent()) return;
      const original = originalFrame(image, PREVIEW_MAX_LONG_EDGE);
      const input = suggestedInput(image);

      if (this.#state.engine !== 'ready') this.#set({ opening: { name: file.name, stage: 'Preparing the darkroom…' } });
      await this.#ready;
      if (!stillCurrent()) return;
      await client.open(image);
      // Tampilan (film, kertas, penyesuaian) dibawa ke foto berikutnya; hanya
      // colour space input yang milik berkas.
      const params = { ...this.#state.params, ...input };
      await client.setParams(input);
      this.#set({
        params,
        defaults: { ...BASELINE_RENDER_PARAMS, ...input },
        original,
        fileName: file.name,
        opening: { name: file.name, stage: 'Developing…' },
      });
      await this.#renderOnce();
      if (!stillCurrent()) return;
      this.#set({ phase: 'editing', opening: undefined });
    } catch (error) {
      if (!stillCurrent()) return;
      this.#set({ phase: this.#state.frame && this.#state.phase === 'editing' ? 'editing' : 'idle', opening: undefined, error: describeError(error, file.name) });
    }
  }

  cancelOpening(): void {
    this.#openToken += 1;
    this.#set({ phase: this.#state.fileName && this.#state.frame ? 'editing' : 'idle', opening: undefined });
  }

  closePhoto(): void {
    this.#openToken += 1;
    this.#set({ phase: 'idle', frame: undefined, original: undefined, fileName: undefined, opening: undefined });
  }

  dismissError(): void {
    this.#set({ error: undefined });
  }

  isEdited(): boolean {
    const { params, defaults } = this.#state;
    return (Object.keys(params) as Array<keyof RenderParams>).some((k) => params[k] !== defaults[k]);
  }

  setParams(patch: Partial<RenderParams>): void {
    const client = this.#client;
    if (!client) return;
    const previous = this.#state.params;
    this.#set({ params: { ...previous, ...patch } });
    client.setParams(patch).then(
      () => this.requestRender(),
      (error: unknown) => this.#set({ params: previous, error: describeError(error) }),
    );
  }

  resetAll(): void {
    const { params, defaults } = this.#state;
    const patch: Partial<RenderParams> = {};
    for (const key of Object.keys(defaults) as Array<keyof RenderParams>) {
      if (params[key] !== defaults[key]) (patch as Record<string, unknown>)[key] = defaults[key];
    }
    if (Object.keys(patch).length > 0) this.setParams(patch);
  }

  requestRender(): void {
    if (this.#state.phase === 'idle') return;
    if (this.#inFlight) {
      this.#dirty = true;
      return;
    }
    void this.#renderLoop();
  }

  async #renderLoop(): Promise<void> {
    this.#inFlight = true;
    this.#set({ rendering: true });
    try {
      do {
        this.#dirty = false;
        await this.#renderOnce();
      } while (this.#dirty);
    } catch (error) {
      this.#set({ error: describeError(error) });
    } finally {
      this.#inFlight = false;
      this.#set({ rendering: false });
    }
  }

  async #renderOnce(): Promise<void> {
    const client = this.#client!;
    try {
      const result = await client.render('preview');
      this.#set({
        frame: {
          width: result.width,
          height: result.height,
          pixels: rgbToPixels(result.rgb, result.width, result.height),
          colorSpace: canvasColorSpaceFor(this.#state.params.outputColorSpace),
        },
      });
    } catch (error) {
      if (error instanceof RenderSupersededError) return;
      throw error;
    }
  }

  async exportImage(format: ExportFormat): Promise<File> {
    const bytes = await this.#client!.exportImage(format);
    const name = `${baseName(this.#state.fileName)}-dichroic.${EXT[format]}`;
    return new File([bytes as Uint8Array<ArrayBuffer>], name, { type: MIME[format] });
  }

  async exportCube(size: number): Promise<File> {
    const text = await this.#client!.exportCube(size);
    return new File([text], `${baseName(this.#state.fileName)}-dichroic-${size}.cube`, { type: 'text/plain' });
  }
}

export const engine = new Engine();
