/**
 * Slider penggaris (panel HP): penggaris bergaris digeser di bawah penunjuk
 * tengah, seperti tepi film di bawah garis bidik -- bukan knob di trek.
 *
 * - Geser: seluruh rentang = RULER_SPAN px jari (presisi yang sama untuk
 *   semua alat, berapa pun rentangnya). Dilempar: meluncur dengan inersia
 *   dan memantul lembut di ujung rentang.
 * - Detent + haptic di nilai bawaan; ketuk dua kali kembali ke bawaan.
 * - Pergeseran penggaris di motion value (tanpa render React per frame);
 *   nilai dikirim sekali per frame seperti `Slider`.
 * - API sama dengan `Slider` (role="slider", panah/Page/Home/End).
 */
import { animate, motion, useMotionValue, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { snap } from '../model/tools';
import { haptic } from '../haptics';
import { rubberBand } from './controls';
import type { SliderProps } from './controls';

/** Jarak jari (px) untuk seluruh rentang. */
const RULER_SPAN = 520;
/** Target jarak antar garis kecil (px); garis besar tiap MAJOR_EVERY. */
const TICK_TARGET = 10;
const MAJOR_EVERY = 5;
/** Lebar detent di nilai bawaan, sebagai bagian rentang. */
const DETENT = 0.012;
/** Kecepatan lempar minimum (px/s) untuk meluncur, dan konstanta perlambatannya (s). */
const FLICK = 260;
const GLIDE_TIME = 0.325;

/** Jarak garis "bagus" (1, 2, 2.5, 5 x 10^n) supaya ~RULER_SPAN/TICK_TARGET garis. */
function tickValue(range: number): number {
  const raw = (range * TICK_TARGET) / RULER_SPAN;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 2.25 ? 2 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10) * p;
}

export function RulerSlider({ value, min, max, step, onChange, onInteractionChange, label, valueText, disabled, defaultValue }: SliderProps) {
  const reduce = useReducedMotion();
  const range = max - min || 1;
  /** Posisi (px, 0 = min) suatu nilai di penggaris. */
  const at = useCallback((v: number) => ((v - min) / range) * RULER_SPAN, [min, range]);
  // Penggaris digeser -at(value): nilai di bawah penunjuk = nilai sekarang.
  const offset = useMotionValue(-at(value));
  const drag = useRef<{ x0: number; off0: number; samples: Array<{ x: number; t: number }>; inDetent: boolean } | null>(null);
  const glide = useRef<{ stop: () => void } | null>(null);
  const interacting = useRef(false);
  const callbacks = useRef({ onChange, onInteractionChange });
  callbacks.current = { onChange, onInteractionChange };
  const pending = useRef<number | null>(null);
  const frame = useRef(0);

  const emit = useCallback((v: number) => {
    pending.current = v;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (pending.current !== null) callbacks.current.onChange(pending.current);
      pending.current = null;
    });
  }, []);
  const flush = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    if (pending.current !== null) callbacks.current.onChange(pending.current);
    pending.current = null;
  };
  const begin = () => {
    if (interacting.current) return;
    interacting.current = true;
    callbacks.current.onInteractionChange?.(true);
  };
  const finish = () => {
    flush();
    if (!interacting.current) return;
    interacting.current = false;
    callbacks.current.onInteractionChange?.(false);
  };
  useEffect(() => () => {
    glide.current?.stop();
    cancelAnimationFrame(frame.current);
    if (interacting.current) callbacks.current.onInteractionChange?.(false);
  }, []);

  /** Nilai di bawah penunjuk untuk pergeseran `off`, dengan detent di bawaan. */
  const valueAt = (off: number) => {
    const raw = min + (-off / RULER_SPAN) * range;
    const clamped = Math.min(max, Math.max(min, raw));
    const detent = defaultValue !== undefined && Math.abs(clamped - defaultValue) < range * DETENT;
    return { v: detent ? defaultValue : snap(clamped, { min, max, step }), detent };
  };

  // Nilai berubah dari luar (undo, reset, keyboard): penggaris menyusul halus.
  useEffect(() => {
    if (drag.current || glide.current) return;
    const target = -at(value);
    if (Math.abs(offset.get() - target) < 0.5) return;
    if (reduce) offset.set(target);
    else void animate(offset, target, { type: 'spring', duration: 0.35, bounce: 0 });
  }, [value, at, offset, reduce]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    glide.current?.stop();
    glide.current = null;
    offset.stop();
    begin();
    drag.current = { x0: e.clientX, off0: offset.get(), samples: [{ x: e.clientX, t: e.timeStamp }], inDetent: false };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const off = d.off0 + (e.clientX - d.x0);
    // Di luar rentang: karet (penggaris ikut jari sedikit, makin berat).
    const lo = -RULER_SPAN;
    const shown = off > 0 ? rubberBand(off, 60) : off < lo ? lo + rubberBand(off - lo, 60) : off;
    offset.set(shown);
    const { v, detent } = valueAt(off);
    if (detent && !d.inDetent) haptic();
    d.inDetent = detent;
    emit(v);
    d.samples.push({ x: e.clientX, t: e.timeStamp });
    if (d.samples.length > 6) d.samples.shift();
  };
  const onPointerEnd = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    // Kecepatan lempar dari sampel 100 ms terakhir (jari yang berhenti dulu = tidak dilempar).
    const last = d.samples[d.samples.length - 1]!;
    const recent = d.samples.filter((s) => last.t - s.t <= 100);
    const first = recent[0]!;
    const dt = (last.t - first.t) / 1000;
    const velocity = recent.length > 1 && dt > 0 ? (last.x - first.x) / dt : 0;
    const lo = -RULER_SPAN;
    if (reduce || Math.abs(velocity) < FLICK) {
      // Kembali ke dalam rentang (karet) dan pas ke nilai terakhir.
      const { v } = valueAt(offset.get());
      emit(v);
      finish();
      void animate(offset, -at(v), { type: 'spring', duration: 0.4, bounce: 0.2 });
      return;
    }
    // Dilempar: meluncur dengan perlambatan eksponensial (seperti scroll iOS);
    // menabrak ujung rentang: pegas pantul lembut di ujung itu.
    let vel = velocity, off = offset.get(), prev = performance.now(), raf = 0;
    const stop = () => {
      cancelAnimationFrame(raf);
      glide.current = null;
      const { v } = valueAt(offset.get());
      emit(v);
      finish();
    };
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      vel *= Math.exp(-dt / GLIDE_TIME);
      off += vel * dt;
      const edge = off > 0 ? 0 : off < lo ? lo : null;
      if (edge !== null) {
        offset.set(edge);
        emit(valueAt(edge).v);
        void animate(offset, edge, { type: 'spring', velocity: vel * 0.35, stiffness: 320, damping: 26 });
        stop();
        return;
      }
      offset.set(off);
      emit(valueAt(off).v);
      if (Math.abs(vel) < 12) { stop(); return; }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    glide.current = { stop };
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const big = step * 10;
    const next: Record<string, number> = {
      ArrowRight: value + step, ArrowUp: value + step, ArrowLeft: value - step, ArrowDown: value - step,
      PageUp: value + big, PageDown: value - big, Home: min, End: max,
    };
    if (e.key in next) {
      e.preventDefault();
      begin();
      callbacks.current.onChange(snap(next[e.key]!, { min, max, step }));
    }
  };

  const tick = (tickValue(range) / range) * RULER_SPAN;
  const major = tick * MAJOR_EVERY;
  // Garis mulai tepat di nilai bawaan (atau 0 / min), jadi bawaan selalu di garis besar.
  const anchor = at(defaultValue ?? (min < 0 && max > 0 ? 0 : min));
  const phase = (n: number) => `${(((anchor % n) + n) % n).toFixed(2)}px`;
  const here = at(value);
  const base = defaultValue !== undefined ? at(defaultValue) : here;

  return (
    <div
      className="ruler"
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      aria-disabled={disabled || undefined}
      data-disabled={disabled || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onLostPointerCapture={onPointerEnd}
      onKeyDown={onKeyDown}
      onKeyUp={finish}
      onBlur={finish}
      onDoubleClick={() => {
        if (defaultValue === undefined || disabled) return;
        haptic();
        callbacks.current.onChange(defaultValue);
      }}
    >
      <motion.div className="ruler-track" style={{ x: offset, width: RULER_SPAN }} aria-hidden="true">
        <span
          className="ruler-ticks"
          style={{
            backgroundImage: `repeating-linear-gradient(90deg, var(--ruler-major) 0 1.5px, transparent 1.5px ${major}px), repeating-linear-gradient(90deg, var(--ruler-minor) 0 1px, transparent 1px ${tick}px)`,
            backgroundPosition: `${phase(major)} 100%, ${phase(tick)} 100%`,
          }}
        />
        {/* Jarak dari bawaan ke nilai sekarang: pita tipis Signal Blue di kaki penggaris. */}
        <span className="ruler-fill" style={{ left: Math.min(base, here), width: Math.abs(here - base) }} />
        {defaultValue !== undefined && <span className="ruler-home" style={{ left: base }} />}
      </motion.div>
      <span className="ruler-needle" aria-hidden="true" />
    </div>
  );
}
