import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { engine } from './engine/engine';
import type { EngineState } from './engine/engine';

export function useEngineState(): EngineState {
  return useSyncExternalStore(engine.subscribe, engine.getState);
}

export interface SizeClass {
  /** `regular`: lebar ≥ 1080 dan tinggi ≥ 560 (iPad lanskap, desktop). */
  width: 'compact' | 'regular';
  /** Compact dengan tinggi pendek (iPhone lanskap): panel pindah ke samping. */
  landscape: boolean;
}

/**
 * Batas tata letak regular. Dua panel samping memakan 648 px; di bawah ~1080
 * foto dan toolbar-nya tinggal sepotong, jadi layar selebar itu memakai
 * tata letak compact.
 */
const REGULAR_MIN_WIDTH = 1080;

function readSizeClass(): SizeClass {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const regular = w >= REGULAR_MIN_WIDTH && h >= 560;
  return { width: regular ? 'regular' : 'compact', landscape: !regular && w > h && h < 520 };
}

export function useSizeClass(): SizeClass {
  const [size, setSize] = useState(readSizeClass);
  useEffect(() => {
    const onResize = () => setSize((prev) => {
      const next = readSizeClass();
      return prev.width === next.width && prev.landscape === next.landscape ? prev : next;
    });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

/**
 * `image/heic` sengaja TIDAK didaftarkan: tanpanya iOS mengonversi foto HEIC
 * dari Photos menjadi JPEG (dengan Orientation dan profil Display P3), yang
 * lewat decoder `io/` bit-identik. HEIC yang tetap masuk (seret-lepas, Files)
 * dibaca lewat `engine/browserDecode.ts`.
 */
export const ACCEPTED_FILES =
  'image/jpeg,image/png,image/tiff,image/x-exr,image/webp,image/avif,.jpg,.jpeg,.png,.tif,.tiff,.exr,.dng,.cr2,.cr3,.crw,.nef,.nrw,.arw,.srf,.sr2,.raf,.orf,.rw2,.rwl,.pef,.srw,.3fr,.iiq,.x3f,.mrw,.erf,.kdc,.dcr,.mos';

/** Pemilih berkas tersembunyi; `pick()` membukanya dari gestur pengguna. */
export function useFilePicker(onFile: (file: File) => void): { pick: () => void; input: HTMLInputElement | null; ref: (el: HTMLInputElement | null) => void } {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pick = useCallback(() => inputRef.current?.click(), []);
  const ref = useCallback(
    (el: HTMLInputElement | null) => {
      if (inputRef.current) inputRef.current.onchange = null;
      inputRef.current = el;
      if (el) {
        el.onchange = () => {
          const file = el.files?.[0];
          el.value = '';
          if (file) onFile(file);
        };
      }
    },
    [onFile],
  );
  return { pick, input: inputRef.current, ref };
}

/** Lebar elemen, diperbarui lewat ResizeObserver. */
export function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.offsetWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

// ---------------------------------------------------------------------------
// Dialog: Escape menutup dari mana saja dan Tab tetap di dalam dialog. Hanya
// dialog teratas yang menanggapi (mis. Alert galat di atas sheet Ekspor).

const dialogStack: object[] = [];

/** Ada dialog terbuka: pintasan keyboard editor diam. */
export function dialogOpen(): boolean {
  return dialogStack.length > 0;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]';

export function useDialogKeys(ref: React.RefObject<HTMLElement | null>, onEscape: () => void, manageTab = true, enabled = true): void {
  const escape = useRef(onEscape);
  useEffect(() => {
    escape.current = onEscape;
  });
  useEffect(() => {
    if (!enabled) return;
    const token = {};
    dialogStack.push(token);
    const onKeyDown = (e: KeyboardEvent) => {
      const root = ref.current;
      if (!root || dialogStack[dialogStack.length - 1] !== token) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        escape.current();
        return;
      }
      if (e.key !== 'Tab' || !manageTab) return;
      const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.tabIndex >= 0 && !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true' && el.getClientRects().length > 0,
      );
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        e.preventDefault();
        root.focus();
      } else if (!root.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === root)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      dialogStack.splice(dialogStack.indexOf(token), 1);
    };
  }, [ref, manageTab, enabled]);
}
