/**
 * Shared element Recent <-> editor: foto proyek terbang dari bilah Recent ke
 * kotak foto editor saat dibuka, dan kembali ke bilahnya saat ditutup.
 *
 * Buka: salinan foto (thumbnail proyek) berangkat dari bilah, menunggu di
 * tengah area foto selama foto dikembangkan (menggantikan dialog "Opening"),
 * lalu mendarat tepat di kotak foto PhotoView setelah render resep proyek
 * pertama selesai, dan memudar di atas foto aslinya. Batal/gagal: kembali ke
 * bilah. Tutup: salinan kanvas foto terbang ke bilah proyek di Recent.
 *
 * Satu elemen `position: fixed` dianimasikan left/top/width/height (bukan
 * scale) supaya `object-fit: cover` tidak menggepengkan foto saat rasio bilah
 * dan foto berbeda.
 */
import { animate } from 'motion/react';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { engine } from '../engine/engine';
import { useEngineState, useProjects } from '../hooks';
import { Spinner } from './Overlays';

interface Box { left: number; top: number; width: number; height: number }

type Flight =
  | { key: number; mode: 'open'; projectId: string; src: string; from: Box; aspect: number }
  | { key: number; mode: 'close'; projectId: string; snapshot: HTMLCanvasElement; from: Box };

let current: Flight | undefined;
let nextKey = 1;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getFlight = () => current;

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const boxOf = (el: Element): Box => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; };

/** Foto proyek yang sedang tampil di editor (kotak pas PhotoView). */
function photoElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-photo-box]');
}

/** Bilah proyek di Recent. */
function slatElement(projectId: string): HTMLElement | null {
  return document.getElementById(`recent-${projectId}`);
}

/** Mulai penerbangan buka dari bilah Recent. `false`: tidak terbang (pakai dialog biasa). */
export function launchOpen(projectId: string, src: string | undefined, from: Element, aspect: number): boolean {
  if (!src || reduced()) return false;
  current = { key: nextKey++, mode: 'open', projectId, src, from: boxOf(from), aspect: aspect > 0 ? aspect : 1 };
  emit();
  return true;
}

/** Mulai penerbangan tutup dari foto editor ke bilah proyek (dipanggil sebelum foto ditutup). */
export function launchClose(projectId: string | undefined): void {
  const el = photoElement();
  const source = el?.querySelector('canvas');
  if (!projectId || !el || !source || reduced()) return;
  const snapshot = document.createElement('canvas');
  snapshot.width = source.width;
  snapshot.height = source.height;
  try {
    snapshot.getContext('2d')?.drawImage(source, 0, 0);
  } catch {
    return;
  }
  current = { key: nextKey++, mode: 'close', projectId, snapshot, from: boxOf(el) };
  emit();
}

/** Ada penerbangan buka: dialog "Opening" tidak perlu tampil. */
export function useOpenFlight(): boolean {
  return useSyncExternalStore(subscribe, getFlight, getFlight)?.mode === 'open';
}

/** Selama foto terangkat dari Recent, isi Recent di belakangnya memudar (styles.css). */
function setLifted(on: boolean) {
  if (on) document.documentElement.dataset.flight = 'open';
  else delete document.documentElement.dataset.flight;
}

function finish(key: number) {
  if (current?.key !== key) return;
  current = undefined;
  setLifted(false);
  emit();
}

/** Kotak tunggu: foto pas di tengah area foto selama dikembangkan. */
function holdBox(aspect: number): Box {
  const stage = document.querySelector('.start-stage')?.getBoundingClientRect()
    ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  const padX = 24, padY = Math.max(48, stage.height * 0.14);
  const w = Math.max(1, stage.width - padX * 2), h = Math.max(1, stage.height - padY * 2);
  const width = Math.min(w, h * aspect), height = width / aspect;
  return { left: stage.left + (stage.width - width) / 2, top: stage.top + (stage.height - height) / 2 - 12, width, height };
}

const FLY = { type: 'spring' as const, duration: 0.55, bounce: 0.12 };

/** Tunggu sampai `get` mengembalikan elemen (maks. `ms`), per frame. */
function waitFor<T>(get: () => T | null | undefined, ms: number, alive: () => boolean): Promise<T | undefined> {
  const end = performance.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (!alive()) return resolve(undefined);
      const v = get();
      if (v) return resolve(v);
      if (performance.now() > end) return resolve(undefined);
      requestAnimationFrame(tick);
    };
    tick();
  });
}

export function PhotoFlight() {
  const flight = useSyncExternalStore(subscribe, getFlight, getFlight);
  const ref = useRef<HTMLDivElement>(null);
  const slot = useRef<HTMLDivElement>(null);
  const engineState = useEngineState();
  // Proyek dibuka lewat engine.openFile lebih dulu, lalu currentId menyusul.
  const projectsState = useProjects();

  // Penerbangan tutup: salinan kanvas dipasang di dalam elemen terbang.
  useEffect(() => {
    if (flight?.mode !== 'close' || !slot.current) return;
    const c = flight.snapshot;
    c.className = 'photo-flight-media';
    slot.current.replaceChildren(c);
  }, [flight]);

  useEffect(() => {
    const el = ref.current;
    if (!flight || !el) return undefined;
    const key = flight.key;
    const alive = () => current?.key === key;
    const place = (b: Box, radius: number) => {
      Object.assign(el.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px`, borderRadius: `${radius}px`, opacity: '1' });
    };
    const fly = (b: Box, radius: number) => animate(el, { left: b.left, top: b.top, width: b.width, height: b.height, borderRadius: radius }, FLY);
    const fadeOut = async () => {
      if (!alive()) return;
      await animate(el, { opacity: 0 }, { duration: 0.18, ease: 'easeOut' });
      finish(key);
    };

    if (flight.mode === 'open') {
      setLifted(true);
      place(flight.from, 14);
      void fly(holdBox(flight.aspect), 12);
      return undefined;
    }
    // Tutup: terbang ke bilah proyek setelah Recent terpasang.
    place(flight.from, 0);
    void (async () => {
      const target = await waitFor(() => slatElement(flight.projectId), 900, alive);
      if (!alive()) return;
      if (!target) return fadeOut();
      // Recent muncul dengan gerak naik singkat: ukur setelah ia diam.
      await new Promise((r) => setTimeout(r, 60));
      if (!alive()) return;
      await fly(boxOf(target), 14);
      await fadeOut();
    })();
    return undefined;
  }, [flight]);

  // Penerbangan buka: mendarat saat proyek terbuka dan render resepnya selesai;
  // kembali ke bilah bila dibatalkan atau gagal (baru dinilai setelah engine
  // sempat membuka: proyek dimuat dari IndexedDB dulu).
  const landing = useRef(0);
  const sawOpening = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (flight?.mode !== 'open' || !el || landing.current === flight.key) return;
    const key = flight.key;
    const alive = () => current?.key === key;
    if (engineState.phase === 'opening') sawOpening.current = key;
    const opened = projectsState.currentId === flight.projectId
      && engineState.phase === 'editing' && !!engineState.frame && !engineState.rendering;
    const failed = sawOpening.current === key && engineState.phase !== 'opening' && projectsState.currentId !== flight.projectId
      && (engineState.phase === 'idle' || !!engineState.error);
    // Berkas asli ternyata hilang (tanpa membuka engine): kartu jadi "missing".
    const missing = projectsState.list.find((c) => c.id === flight.projectId)?.missing;
    if (!opened && !failed && !missing) return;
    landing.current = key;
    void (async () => {
      if (opened) {
        const target = await waitFor(() => photoElement(), 1200, alive);
        if (!alive()) return;
        if (target) await animate(el, { ...boxOf(target), borderRadius: 0 }, FLY);
      } else {
        setLifted(false);
        const back = slatElement(flight.projectId);
        if (back) await animate(el, { ...boxOf(back), borderRadius: 14 }, FLY);
      }
      if (!alive()) return;
      await animate(el, { opacity: 0 }, { duration: 0.18, ease: 'easeOut' });
      finish(key);
    })();
  }, [flight, engineState, projectsState]);

  // Jaring pengaman: penerbangan yang tersangkut dilepas.
  useEffect(() => {
    if (!flight) return undefined;
    const key = flight.key;
    const t = window.setTimeout(() => finish(key), flight.mode === 'open' ? 60_000 : 3000);
    return () => window.clearTimeout(t);
  }, [flight]);

  if (!flight) return null;
  const opening = flight.mode === 'open' && engineState.phase === 'opening' ? engineState.opening : undefined;
  return (
    <div className="photo-flight-layer" aria-hidden={flight.mode === 'close' || undefined}>
      <div ref={ref} key={flight.key} className="photo-flight">
        {flight.mode === 'open' ? <img className="photo-flight-media" src={flight.src} alt="" draggable={false} /> : <div ref={slot} className="photo-flight-slot" />}
      </div>
      {opening && (
        <div className="photo-flight-status" role="status" aria-live="polite">
          <Spinner size={16} />
          <span>{opening.stage}</span>
          <button type="button" className="photo-flight-cancel" onClick={() => engine.cancelOpening()}>Cancel</button>
        </div>
      )}
    </div>
  );
}
