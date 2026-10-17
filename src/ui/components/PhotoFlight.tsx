/**
 * Shared element Recent <-> editor: foto proyek terbang dari bilah Recent ke
 * kotak foto editor saat dibuka, dan kembali ke bilahnya saat ditutup.
 *
 * Buka: salinan foto (thumbnail proyek) terangkat dari bilah ke perkiraan
 * kotak foto editor dan menunggu di sana selama foto dikembangkan (pil status
 * + Cancel menggantikan dialog "Opening"); setelah render resep proyek
 * selesai, salinan mendarat tepat di kotak foto PhotoView, foto asli muncul
 * di bawahnya pada frame yang sama, dan salinan memudar. Selama penerbangan
 * foto editor disembunyikan, jadi tidak pernah tampak dua foto. Batal/gagal:
 * kembali ke bilah. Tutup: salinan kanvas foto terbang ke bilah proyek.
 *
 * Gerak murni transform (WAAPI, compositor): tetap mulus walau thread utama
 * sibuk decode/render. Rasio bilah dan foto berbeda, jadi potongan "cover"
 * dibuat dengan dua lapis: bingkai luar di-scale non-seragam ke kotak saat
 * itu (overflow hidden), isi di dalamnya di-scale balik supaya foto tidak
 * gepeng. Pegas disampel jadi keyframe, jadi interpolasi skala-balik di
 * antaranya nyaris eksak.
 */
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { engine } from '../engine/engine';
import { useEngineState, useProjects } from '../hooks';
import { Spinner } from './Overlays';

interface Box { left: number; top: number; width: number; height: number }

type Flight =
  | { key: number; mode: 'open'; projectId: string; src: string; from: Box; aspect: number }
  | { key: number; mode: 'close'; projectId: string; snapshot: HTMLCanvasElement; from: Box; aspect: number };

let current: Flight | undefined;
let nextKey = 1;
/** Kotak foto editor terakhir yang terlihat: perkiraan tempat mendarat berikutnya. */
let lastPhotoBox: Box | undefined;
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

/** Bilah proyek di Recent (bagian fotonya). */
function slatElement(projectId: string): HTMLElement | null {
  const slat = document.getElementById(`recent-${projectId}`);
  return slat?.querySelector<HTMLElement>('.recent-lift') ?? slat;
}

/**
 * Tahap penerbangan untuk styles.css: `open` (Recent memudar, foto editor dan
 * kontrolnya disembunyikan), `land` (kontrol editor memudar masuk), `close`
 * (foto bilah tujuan disembunyikan sampai salinan mendarat).
 */
function setStage(stage: 'open' | 'land' | 'close' | undefined) {
  if (stage) document.documentElement.dataset.flight = stage;
  else delete document.documentElement.dataset.flight;
}

/** Penerbangan tutup sedang berlangsung: Recent tampil tanpa animasi naik. */
export function isClosingFlight(): boolean {
  return current?.mode === 'close';
}

/** Mulai penerbangan buka dari bilah Recent. `false`: tidak terbang (pakai dialog biasa). */
export function launchOpen(projectId: string, src: string | undefined, from: Element, aspect: number): boolean {
  if (!src || reduced()) return false;
  current = { key: nextKey++, mode: 'open', projectId, src, from: boxOf(from), aspect: aspect > 0 ? aspect : 1 };
  setStage('open');
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
  const from = boxOf(el);
  lastPhotoBox = from;
  current = { key: nextKey++, mode: 'close', projectId, snapshot, from, aspect: source.width / Math.max(1, source.height) };
  setStage('close');
  emit();
}

/** Ada penerbangan buka: dialog "Opening" tidak perlu tampil. */
export function useOpenFlight(): boolean {
  return useSyncExternalStore(subscribe, getFlight, getFlight)?.mode === 'open';
}

function finish(key: number) {
  if (current?.key !== key) return;
  current = undefined;
  setStage(undefined);
  emit();
}

/** Perkiraan kotak foto editor (pas di area foto) selama foto dikembangkan. */
function holdBox(aspect: number): Box {
  const fit = (area: Box): Box => {
    const width = Math.min(area.width, area.height * aspect), height = width / aspect;
    return { left: area.left + (area.width - width) / 2, top: area.top + (area.height - height) / 2, width, height };
  };
  // Kotak foto terakhir: area fotonya sama; rasio bisa beda, jadi pas ulang di dalamnya.
  if (lastPhotoBox) {
    const vw = window.innerWidth;
    const area = { left: 0, top: lastPhotoBox.top, width: vw, height: lastPhotoBox.height };
    if (lastPhotoBox.width < vw - 1) Object.assign(area, { left: lastPhotoBox.left, width: lastPhotoBox.width });
    return fit(area);
  }
  const stage = document.querySelector('.start-stage')?.getBoundingClientRect();
  const wide = document.documentElement.dataset.size === 'regular';
  if (stage && wide) return fit({ left: stage.left + 16, top: stage.top + 16, width: stage.width - 32, height: stage.height - 32 });
  // HP: bar atas ~80 px, panel kontrol ~36 % tinggi di bawah.
  const h = window.innerHeight;
  return fit({ left: 0, top: 80, width: window.innerWidth, height: Math.max(120, h * 0.64 - 92) });
}

/** Pegas sedikit membal (bounce ~0.1), disampel 0..1 sepanjang `FLY_MS`. */
const FLY_MS = 520;
const SAMPLES = 36;
const SPRING = (() => {
  const zeta = 0.82, omega = 13.5, wd = omega * Math.sqrt(1 - zeta * zeta);
  return Array.from({ length: SAMPLES + 1 }, (_, i) => {
    const t = (i / SAMPLES) * (FLY_MS / 1000);
    if (i === SAMPLES) return 1;
    return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
  });
})();

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const mix = (a: Box, b: Box, p: number): Box => ({ left: lerp(a.left, b.left, p), top: lerp(a.top, b.top, p), width: lerp(a.width, b.width, p), height: lerp(a.height, b.height, p) });

/**
 * Terbangkan bingkai `outer` (berisi `inner`, foto rasio `aspect`) dari kotak
 * `from` ke `to`, radius sudut `r0` -> `r1` (px layar). Bingkai diletakkan di
 * `to`; semua keyframe transform relatif terhadapnya.
 */
function fly(outer: HTMLElement, inner: HTMLElement, from: Box, to: Box, aspect: number, r0: number, r1: number): Promise<void> {
  const coverW = (b: Box) => Math.max(b.width, b.height * aspect);
  const baseW = coverW(to), baseH = baseW / aspect;
  // Segmen sebelumnya (fill: forwards) dilepas; gaya baru dipasang pada tugas yang sama, jadi tanpa frame kosong.
  for (const a of [...outer.getAnimations(), ...inner.getAnimations()]) a.cancel();
  Object.assign(outer.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });
  Object.assign(inner.style, { width: `${baseW}px`, height: `${baseH}px` });
  const outerFrames: Keyframe[] = [], innerFrames: Keyframe[] = [];
  SPRING.forEach((p, i) => {
    const b = mix(from, to, p);
    const sx = b.width / to.width, sy = b.height / to.height;
    const cw = coverW(b), ch = cw / aspect, k = cw / baseW;
    const r = lerp(r0, r1, Math.min(1, p));
    const offset = i / SAMPLES;
    outerFrames.push({ offset, transform: `translate(${b.left - to.left}px, ${b.top - to.top}px) scale(${sx}, ${sy})`, borderRadius: `${r / sx}px / ${r / sy}px` });
    innerFrames.push({ offset, transform: `translate(${(b.width - cw) / 2 / sx}px, ${(b.height - ch) / 2 / sy}px) scale(${k / sx}, ${k / sy})` });
  });
  const opts: KeyframeAnimationOptions = { duration: FLY_MS, easing: 'linear', fill: 'forwards' };
  const a = outer.animate(outerFrames, opts);
  inner.animate(innerFrames, opts);
  return a.finished.then(() => undefined, () => undefined);
}

function fadeOut(outer: HTMLElement): Promise<void> {
  return outer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: 'ease-out', fill: 'forwards' })
    .finished.then(() => undefined, () => undefined);
}

/** Tunggu sampai `get` mengembalikan nilai (maks. `ms`), per frame. */
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

/**
 * Kotak elemen setelah tata letaknya diam (sama 3 frame berturut-turut, maks.
 * `ms`): foto editor baru terpasang masih bergeser saat panel kontrol
 * terukur, dan mendarat di kotak lama membuat lompatan saat salinan memudar.
 */
async function stableBox(get: () => Element | null, ms: number, alive: () => boolean): Promise<Box | undefined> {
  const end = performance.now() + ms;
  let last: Box | undefined, same = 0;
  while (alive() && performance.now() < end) {
    const el = get();
    const box = el ? boxOf(el) : undefined;
    const equal = !!box && !!last && Math.abs(box.left - last.left) < 0.5 && Math.abs(box.top - last.top) < 0.5
      && Math.abs(box.width - last.width) < 0.5 && Math.abs(box.height - last.height) < 0.5;
    same = equal ? same + 1 : 0;
    last = box;
    if (box && same >= 2) return box;
    await new Promise((r) => requestAnimationFrame(r));
  }
  return last;
}

export function PhotoFlight() {
  const flight = useSyncExternalStore(subscribe, getFlight, getFlight);
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const engineState = useEngineState();
  // Proyek dibuka lewat engine.openFile lebih dulu, lalu currentId menyusul.
  const projectsState = useProjects();
  /** Kotak tempat salinan berada sekarang (akhir segmen terakhir) dan segmen yang berjalan. */
  const at = useRef<{ box: Box; radius: number; moving: Promise<void> }>({ box: { left: 0, top: 0, width: 0, height: 0 }, radius: 0, moving: Promise.resolve() });

  // Penerbangan tutup: salinan kanvas dipasang di dalam bingkai.
  useLayoutEffect(() => {
    if (flight?.mode !== 'close' || !innerRef.current) return;
    flight.snapshot.className = 'photo-flight-media';
    innerRef.current.replaceChildren(flight.snapshot);
  }, [flight]);

  // Segmen pertama: buka = terangkat ke kotak tunggu; tutup = ke bilah tujuan.
  useLayoutEffect(() => {
    const outer = outerRef.current, inner = innerRef.current;
    if (!flight || !outer || !inner) return;
    const key = flight.key;
    const alive = () => current?.key === key;
    if (flight.mode === 'open') {
      const to = holdBox(flight.aspect);
      at.current = { box: to, radius: 12, moving: fly(outer, inner, flight.from, to, flight.aspect, 14, 12) };
      return;
    }
    // Tutup: Recent tampil tanpa animasi naik (isClosingFlight); ukur bilahnya setelah terpasang.
    Object.assign(outer.style, { left: `${flight.from.left}px`, top: `${flight.from.top}px`, width: `${flight.from.width}px`, height: `${flight.from.height}px` });
    Object.assign(inner.style, { width: `${flight.from.width}px`, height: `${flight.from.height}px` });
    void (async () => {
      await waitFor(() => slatElement(flight.projectId), 900, alive);
      const target = await stableBox(() => slatElement(flight.projectId), 500, alive);
      if (target && alive()) await fly(outer, inner, flight.from, target, flight.aspect, 0, 14);
      if (!alive()) return;
      // Foto bilah muncul di bawah salinan pada frame yang sama, lalu salinan memudar.
      setStage(undefined);
      await fadeOut(outer);
      finish(key);
    })();
  }, [flight]);

  // Buka: mendarat saat proyek terbuka dan render resepnya selesai; kembali ke
  // bilah bila dibatalkan atau gagal (baru dinilai setelah engine sempat
  // membuka: proyek dimuat dari IndexedDB dulu).
  const landing = useRef(0);
  const sawOpening = useRef(0);
  useEffect(() => {
    const outer = outerRef.current, inner = innerRef.current;
    if (flight?.mode !== 'open' || !outer || !inner || landing.current === flight.key) return;
    const key = flight.key;
    const alive = () => current?.key === key;
    if (engineState.phase === 'opening') sawOpening.current = key;
    // Foto hasil decode browser (dengan look) sudah tampil di editor: mendarat sekarang;
    // engine menyusul di bawahnya. Tanpa itu (RAW): tunggu render resep proyek.
    const opened = (engineState.phase === 'opening' && !!engineState.preview)
      || (projectsState.currentId === flight.projectId && engineState.phase === 'editing' && !!engineState.frame && !engineState.rendering);
    const failed = sawOpening.current === key && engineState.phase !== 'opening' && projectsState.currentId !== flight.projectId
      && (engineState.phase === 'idle' || !!engineState.error);
    // Berkas asli ternyata hilang (tanpa membuka engine): kartu jadi "missing".
    const missing = projectsState.list.find((c) => c.id === flight.projectId)?.missing;
    if (!opened && !failed && !missing) return;
    landing.current = key;
    void (async () => {
      await at.current.moving;
      if (!alive()) return;
      if (opened) {
        // Foto editor sudah terpasang tetapi tersembunyi (data-flight): ukur setelah diam, lalu mendarat.
        await waitFor(() => photoElement(), 1200, alive);
        const box = await stableBox(photoElement, 700, alive);
        if (!alive()) return;
        if (box) {
          lastPhotoBox = box;
          setStage('land');
          await fly(outer, inner, at.current.box, box, flight.aspect, at.current.radius, 0);
        }
      } else {
        setStage(undefined);
        const back = slatElement(flight.projectId);
        if (back) await fly(outer, inner, at.current.box, boxOf(back), flight.aspect, at.current.radius, 14);
      }
      if (!alive()) return;
      setStage(undefined);
      await fadeOut(outer);
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
      <div ref={outerRef} key={flight.key} className="photo-flight">
        <div ref={innerRef} className="photo-flight-inner">
          {flight.mode === 'open' && <img className="photo-flight-media" src={flight.src} alt="" draggable={false} />}
        </div>
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
