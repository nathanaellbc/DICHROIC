import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { engine } from './engine/engine';
import type { EngineState } from './engine/engine';

export function useEngineState(): EngineState {
  return useSyncExternalStore(engine.subscribe, engine.getState);
}

export interface SizeClass {
  /** `regular`: lebar ≥ 900 dan tinggi ≥ 560 (iPad lanskap, desktop). */
  width: 'compact' | 'regular';
  /** Compact dengan tinggi pendek (iPhone lanskap): panel pindah ke samping. */
  landscape: boolean;
}

function readSizeClass(): SizeClass {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const regular = w >= 900 && h >= 560;
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

export const ACCEPTED_FILES =
  'image/jpeg,image/png,image/tiff,image/x-exr,.jpg,.jpeg,.png,.tif,.tiff,.exr,.dng,.cr2,.cr3,.crw,.nef,.nrw,.arw,.srf,.sr2,.raf,.orf,.rw2,.rwl,.pef,.srw,.3fr,.iiq,.x3f,.mrw,.erf,.kdc,.dcr,.mos';

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
