/**
 * Pil pilihan bergaya "Rubber Segment" (React Bits Micro), dipakai Segmented
 * dan GroupTabs. Pil digambar sekali di wadah dengan dua tepi bergerak:
 *
 * - ketukan: pil meregang menutupi asal dan tujuan (0,19 s, ease-out), lalu
 *   tepi depan mendarat dengan pegas dan tepi belakang sedikit melewati
 *   target sebelum rileks (squash);
 * - seret pil: ikut jari, karet di ujung wadah; lepas -> slot terdekat dari
 *   posisi + proyeksi kecepatan, lemparan cepat selalu pindah satu slot.
 *
 * Tombol tetap tombol asli (klik, keyboard, VoiceOver); seret yang benar-benar
 * bergeser menelan klik berikutnya. Reduce Motion: pil langsung pindah.
 */
import { animate, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import type { MotionValue } from 'motion/react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1];
const SPRING_UI = { type: 'spring' as const, duration: 0.3, bounce: 0 };
const SPRING_MOMENTUM = { type: 'spring' as const, duration: 0.4, bounce: 0.2 };
const SPRING_RELAX = { type: 'spring' as const, duration: 0.16, bounce: 0 };
const DILATE = 0.19;
const HANDOFF = 0.15;
const SQUASH = 3;
const FLICK = 110;
const MAX_VELOCITY = 2000;
const DEADZONE = 4;
const RUBBER = 0.55;

interface Slot { l: number; r: number }
interface Drag { id: number; x0: number; live: boolean; offset: number; w: number; hist: Array<[number, number]> }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const rubber = (over: number, dim: number) => (over * dim * RUBBER) / (dim + RUBBER * Math.abs(over));
/** Jarak luncur dari kecepatan (px/detik), seperti momentum gulir. */
const project = (v: number) => (v / 1000) * 0.12;

function velocityOf(hist: Array<[number, number]>, now: number): number {
  const recent = hist.filter(([t]) => now - t <= 100);
  if (recent.length < 2) return 0;
  const [t0, x0] = recent[0]!;
  const [t1, x1] = recent[recent.length - 1]!;
  return t1 - t0 >= 8 ? ((x1 - x0) / (t1 - t0)) * 1000 : 0;
}

export interface RubberPill {
  trackRef: (el: HTMLElement | null) => void;
  itemRef: (index: number) => (el: HTMLElement | null) => void;
  /** Tepi kiri dan lebar pil (px, relatif wadah). */
  x: MotionValue<number>;
  width: MotionValue<number>;
  /** Pasang di wadah: seret pil. */
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
  };
  /** true bila klik ini sisa seret (abaikan). */
  swallowClick: () => boolean;
}

/**
 * `index`: slot terpilih (-1 = tidak ada). `onSelect` dipanggil saat seret
 * mendarat di slot lain. `pad`: pil lebih sempit dari slot sebanyak ini di
 * tiap sisi (garis bawah tab desktop).
 */
export function useRubberPill(count: number, index: number, onSelect: (index: number) => void, { pad = 0, draggable = true } = {}): RubberPill {
  const reduce = useReducedMotion();
  const track = useRef<HTMLElement | null>(null);
  const items = useRef<Array<HTMLElement | null>>([]);
  const slots = useRef<Slot[]>([]);
  const committed = useRef(index);
  const drag = useRef<Drag | null>(null);
  const handoff = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gen = useRef(0);
  const swallow = useRef(false);
  const left = useMotionValue(0);
  const right = useMotionValue(0);
  const width = useTransform([left, right], ([l, r]: number[]) => Math.max(0, r! - l!));
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const jumpTo = (i: number) => {
    const s = slots.current[i];
    if (!s) return;
    clearTimeout(handoff.current);
    gen.current += 1;
    left.jump(s.l);
    right.jump(s.r);
  };
  const measure = () => {
    slots.current = Array.from({ length: count }, (_, i) => {
      const el = items.current[i];
      return el ? { l: el.offsetLeft + pad, r: el.offsetLeft + el.offsetWidth - pad } : { l: 0, r: 0 };
    });
    if (!drag.current) jumpTo(committed.current);
  };

  useLayoutEffect(() => {
    measure();
    const observer = new ResizeObserver(measure);
    if (track.current) observer.observe(track.current);
    for (const el of items.current) if (el) observer.observe(el);
    void document.fonts?.ready.then(measure);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, pad]);

  const land = (to: number, v: number | null, flick: boolean, squash: boolean) => {
    const b = slots.current[to];
    if (!b) return;
    const g = ++gen.current;
    const dir = Math.sign((b.l + b.r) / 2 - (left.get() + right.get()) / 2) || 1;
    const [lead, leadTo, trail, trailTo] = dir > 0 ? [right, b.r, left, b.l] : [left, b.l, right, b.r];
    const velocity = (mv: MotionValue<number>) => clamp(v ?? mv.getVelocity(), -MAX_VELOCITY, MAX_VELOCITY);
    animate(lead, leadTo, { ...(flick ? SPRING_MOMENTUM : SPRING_UI), velocity: velocity(lead) });
    if (!squash) {
      animate(trail, trailTo, { ...SPRING_UI, velocity: velocity(trail) });
      return;
    }
    void animate(trail, trailTo + dir * SQUASH, { ...SPRING_UI, velocity: velocity(trail) }).then(() => {
      if (gen.current === g) animate(trail, trailTo, SPRING_RELAX);
    });
  };
  const travel = (from: number, to: number) => {
    const a = slots.current[from];
    const b = slots.current[to];
    if (!a || !b) return jumpTo(to);
    clearTimeout(handoff.current);
    gen.current += 1;
    if (reduce) return jumpTo(to);
    const tween = { duration: DILATE, ease: EASE_OUT };
    animate(left, Math.min(a.l, b.l), tween);
    animate(right, Math.max(a.r, b.r), tween);
    handoff.current = setTimeout(() => land(to, null, false, true), HANDOFF * 1000);
  };

  // Perubahan dari luar (klik, keyboard, state): regang lalu mendarat.
  useEffect(() => {
    if (drag.current || committed.current === index) return;
    const from = committed.current;
    committed.current = index;
    if (from < 0 || index < 0) jumpTo(index);
    else travel(from, index);
  });
  useEffect(() => () => { clearTimeout(handoff.current); left.stop(); right.stop(); }, [left, right]);

  const localX = (e: { clientX: number }) => e.clientX - (track.current?.getBoundingClientRect().left ?? 0);
  const handlers: RubberPill['handlers'] = {
    onPointerDown: (e) => {
      if (!draggable || drag.current || e.button !== 0 || committed.current < 0) return;
      const x = localX(e);
      if (x < left.get() || x > right.get()) return; // hanya pil yang bisa diseret
      drag.current = { id: e.pointerId, x0: x, live: false, offset: 0, w: 0, hist: [[e.timeStamp, x]] };
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* elemen sudah lepas */ }
      clearTimeout(handoff.current);
      gen.current += 1;
      left.stop();
      right.stop();
    },
    onPointerMove: (e) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      const x = localX(e);
      d.hist.push([e.timeStamp, x]);
      if (d.hist.length > 8) d.hist.shift();
      if (!d.live) {
        if (Math.abs(x - d.x0) < DEADZONE) return;
        d.live = true;
        d.offset = x - left.get();
        d.w = right.get() - left.get();
        track.current?.setAttribute('data-held', '');
      }
      const first = slots.current[0]!;
      const last = slots.current[slots.current.length - 1]!;
      const l = x - d.offset;
      const minL = first.l;
      const maxL = last.r - d.w;
      if (reduce) {
        const c = clamp(l, minL, maxL);
        left.set(c);
        right.set(c + d.w);
      } else if (l < minL) {
        // Karet: tepi luar menempel, pil memendek.
        left.set(minL);
        right.set(minL + d.w - rubber(minL - l, d.w));
      } else if (l > maxL) {
        right.set(last.r);
        left.set(maxL + rubber(l - maxL, d.w));
      } else {
        left.set(l);
        right.set(l + d.w);
      }
    },
    onPointerUp: (e) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      drag.current = null;
      track.current?.removeAttribute('data-held');
      if (!d.live) return; // ketukan biasa: biarkan klik tombol yang menangani
      swallow.current = true;
      setTimeout(() => { swallow.current = false; }, 0);
      const v = velocityOf(d.hist, e.timeStamp);
      const flick = Math.abs(v) > FLICK;
      const centre = (left.get() + right.get()) / 2 + project(v);
      let to = 0;
      slots.current.forEach((s, i) => {
        const best = slots.current[to]!;
        if (Math.abs((s.l + s.r) / 2 - centre) < Math.abs((best.l + best.r) / 2 - centre)) to = i;
      });
      if (flick && to === committed.current) to = clamp(to + Math.sign(v), 0, count - 1);
      committed.current = to;
      if (reduce) jumpTo(to);
      else land(to, v, flick, flick);
      if (to !== index) onSelectRef.current(to);
    },
    onPointerCancel: (e) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      drag.current = null;
      track.current?.removeAttribute('data-held');
      if (d.live) land(committed.current, null, false, false);
    },
  };

  return {
    trackRef: (el) => { track.current = el; },
    itemRef: (i) => (el) => { items.current[i] = el; },
    x: left,
    width,
    handlers,
    swallowClick: () => {
      const s = swallow.current;
      swallow.current = false;
      return s;
    },
  };
}
