/**
 * Kontrol standar bergaya iOS: segmented control, switch, slider, stepper,
 * dan baris pilihan kapsul. Semuanya elemen asli (`button`, role ARIA yang
 * tepat) supaya bisa dipakai dengan VoiceOver dan keyboard.
 */
import { AnimatePresence, animate, motion, useMotionValue, useReducedMotion, useSpring, useTransform, useVelocity } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { pressRelease, pressScale } from '../motion';
import { snap } from '../model/tools';
import { Icon } from './Icon';
import { useRubberPill } from './rubberPill';
import type { UiIconName } from './Icon';

// ---------------------------------------------------------------------------

export interface SegmentItem<V extends string> {
  value: V;
  label: string;
}

export function Segmented<V extends string>({
  items,
  value,
  onChange,
  label,
  small,
}: {
  items: readonly SegmentItem<V>[];
  value: V;
  onChange: (value: V) => void;
  label: string;
  small?: boolean;
}) {
  const index = items.findIndex((item) => item.value === value);
  const pill = useRubberPill(items.length, index, (i) => onChange(items[i]!.value));
  return (
    <div ref={pill.trackRef} role="group" aria-label={label} className={`segmented${small ? ' small' : ''}${items.length >= 4 ? ' dense' : ''}`} {...pill.handlers}>
      {index >= 0 && <motion.span className="segment-pill" aria-hidden="true" style={{ x: pill.x, width: pill.width }} />}
      {items.map((item, i) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={pill.itemRef(i)}
            type="button"
            className="segment"
            aria-pressed={selected}
            onClick={() => { if (!pill.swallowClick()) onChange(item.value); }}
          >
            <span className="segment-label">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

export interface TabItem<V extends string> {
  value: V;
  label: string;
  icon: UiIconName;
  /** Ada yang diubah di kelompok ini: titik biru, dan ", edited" untuk VoiceOver. */
  edited?: boolean;
}

/**
 * Pemilih kelompok sebagai tab ikon, dengan nama untuk pembaca layar dan
 * tooltip. Panah kiri/kanan, Home dan End berpindah tab (pola ARIA tabs).
 */
export function GroupTabs<V extends string>({
  items,
  value,
  onChange,
  label,
  idPrefix,
  small,
}: {
  items: readonly TabItem<V>[];
  value: V;
  onChange: (value: V) => void;
  label: string;
  /** Awalan id tab; panel yang dikendalikan ber-id `${idPrefix}-panel`. */
  idPrefix: string;
  small?: boolean;
}) {
  const refs = useRef(new Map<V, HTMLButtonElement>());
  const index = items.findIndex((item) => item.value === value);
  // Garis bawah tab desktop lebih sempit 10 px di tiap sisi.
  const pill = useRubberPill(items.length, index, (i) => onChange(items[i]!.value), { pad: small ? 10 : 0 });
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((item) => item.value === value);
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: items.length - 1 };
    if (!(e.key in moves)) return;
    e.preventDefault();
    const next = items[(moves[e.key]! + items.length) % items.length]!;
    onChange(next.value);
    refs.current.get(next.value)?.focus();
  };
  return (
    <div ref={pill.trackRef} role="tablist" aria-label={label} className={`tabs${small ? ' small' : ''}`} onKeyDown={onKeyDown} {...pill.handlers}>
      {index >= 0 && <motion.span className="tab-pill" aria-hidden="true" style={{ x: pill.x, width: pill.width }} />}
      {items.map((item, i) => {
        const selected = item.value === value;
        const setItem = pill.itemRef(i);
        return (
          <button
            key={item.value}
            ref={(el) => {
              setItem(el);
              if (el) refs.current.set(item.value, el);
              else refs.current.delete(item.value);
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${item.value}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            aria-label={`${item.label}${item.edited ? ', edited' : ''}`}
            title={item.label}
            tabIndex={selected ? 0 : -1}
            className="tab"
            onClick={() => { if (!pill.swallowClick()) onChange(item.value); }}
          >
            <span className="tab-icon">
              <Icon name={item.icon} size={small ? 17 : 19} />
              {item.edited && <span className="tab-edited" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Gulir wadah horizontal sehingga `el` di tengah -- tanpa menggulir wadah vertikal di atasnya (scrollIntoView). */
export function centerInScroller(el: HTMLElement): void {
  const scroller = el.parentElement;
  if (!scroller) return;
  const box = scroller.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const left = scroller.scrollLeft + (rect.left - box.left) - (scroller.clientWidth - rect.width) / 2;
  scroller.scrollTo({ left, behavior: 'smooth' });
}

// ---------------------------------------------------------------------------

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();
  // Geometri dari CSS (`--switch-*`), diukur ulang saat kepadatan berubah.
  const geo = useRef({ travel: 20, knob: 27 });
  const knobBase = useMotionValue(27);
  const x = useMotionValue(0);
  const press = useSpring(0, LENS_SPRING);
  const flow = useSpring(useVelocity(x), { stiffness: 320, damping: 40, mass: 0.6 });
  const grow = useTransform(press, (p) => p * SWITCH_GROW);
  const knobWidth = useTransform([grow, knobBase], ([g, k]: number[]) => k! + g!);
  // Knob melebar ke arah tengah trek: ke kanan saat mati, ke kiri saat menyala.
  const left = useTransform([x, grow], ([xv, g]: number[]) => xv! - g! * (xv! / (geo.current.travel || 1)));
  const scaleX = useTransform(flow, (v) => (reduce ? 1 : 1 + Math.min(0.3, Math.abs(v) / 700)));
  const scaleY = useTransform(scaleX, (s) => 1 / Math.sqrt(s));
  const solid = useTransform(press, [0, 0.6], [1, 0]);
  const glass = useTransform(press, [0.15, 1], [0, 1]);
  const grip = useRef<{ id: number; startX: number; x0: number; moved: boolean; onAtPress: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const skipClick = useRef(false);
  const checkedRef = useRef(checked);
  checkedRef.current = checked;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const inset = parseFloat(getComputedStyle(el).getPropertyValue('--switch-inset')) || 2;
      const knob = el.clientHeight - inset * 2;
      geo.current = { travel: el.clientWidth - knob - inset * 2, knob };
      if (!grip.current) x.jump(checkedRef.current ? geo.current.travel : 0);
      knobBase.set(knob);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [x, knobBase]);

  useEffect(() => {
    if (dragging) return undefined;
    const target = checked ? geo.current.travel : 0;
    if (reduce) {
      x.jump(target);
      return undefined;
    }
    const controls = animate(x, target, { type: 'spring', stiffness: 420, damping: 30, mass: 0.8 });
    return () => controls.stop();
  }, [checked, dragging, reduce, x]);

  const commit = (next: boolean) => {
    if (next === checkedRef.current) return;
    checkedRef.current = next;
    onChange(next);
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (disabled || grip.current || e.button !== 0) return;
    grip.current = { id: e.pointerId, startX: e.clientX, x0: x.get(), moved: false, onAtPress: checkedRef.current };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* elemen sudah lepas */ }
    press.set(1);
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const g = grip.current;
    if (!g || g.id !== e.pointerId) return;
    const dx = e.clientX - g.startX;
    if (!g.moved && Math.abs(dx) > (e.pointerType === 'touch' ? 8 : 4)) g.moved = true;
    if (!g.moved) return;
    const travel = geo.current.travel;
    const raw = g.x0 + dx;
    const nx = reduce ? Math.min(travel, Math.max(0, raw))
      : raw < 0 ? -rubberBand(-raw, 12) : raw > travel ? travel + rubberBand(raw - travel, 12) : raw;
    x.set(nx);
    // Berpindah di titik tengah, selagi masih diseret (seperti iOS).
    commit(nx > travel / 2);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => {
    const g = grip.current;
    if (!g || g.id !== e.pointerId) return;
    grip.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* sudah dilepas */ }
    if (cancelled) commit(g.onAtPress);
    else if (!g.moved) commit(!checkedRef.current);
    skipClick.current = true;
    setTimeout(() => { skipClick.current = false; }, 0);
    press.set(0);
    setDragging(false);
  };

  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-held={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => onPointerUp(e, false)}
      onPointerCancel={(e) => onPointerUp(e, true)}
      // Keyboard (Space/Enter) dan VoiceOver; ketukan sudah ditangani pointerup.
      onClick={() => {
        if (skipClick.current) { skipClick.current = false; return; }
        if (!disabled) commit(!checkedRef.current);
      }}
    >
      <motion.span className="switch-knob" style={{ x: left, width: knobWidth, scaleX, scaleY }}>
        <motion.span className="switch-knob-solid" style={{ opacity: solid }} />
        <motion.span className="switch-knob-glass" style={{ opacity: glass }} />
      </motion.span>
    </button>
  );
}

/** Knob switch melebar sebanyak ini (px) saat ditahan, seperti iOS. */
const SWITCH_GROW = 7;

// ---------------------------------------------------------------------------

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onInteractionChange?: (active: boolean) => void;
  label: string;
  valueText: string;
  disabled?: boolean;
  /** Nilai yang dipulihkan dengan ketuk dua kali. */
  defaultValue?: number;
}

/** Karet di luar rentang (gaya UIScrollView): makin jauh makin berat, tak pernah melebihi `dim`. */
export function rubberBand(over: number, dim: number, k = 0.55): number {
  return (over * dim * k) / (dim + k * Math.abs(over));
}

/** Perbesaran trek di dalam lensa kaca knob. */
const LENS_ZOOM = 1.6;
/** Pegas tekan knob: cukup cepat untuk ketukan, lembut saat menjadi lensa. */
const LENS_SPRING = { type: 'spring' as const, stiffness: 520, damping: 36, mass: 0.7 };
/** Regangan menurut kecepatan (px/detik): maksimum 22 % pada ~2200 px/detik. */
const STRETCH_MAX = 0.22;
const STRETCH_SPEED = 2200;
/** Knob diam dan lensa (px); `track` = tebal trek, untuk memusatkan knob vertikal. */
const KNOB = {
  compact: { rest: 24, lensW: 36, lensH: 24, track: 4 },
  regular: { rest: 14, lensW: 22, lensH: 13, track: 3 },
};

/**
 * Slider dengan seret RELATIF (seperti Photos): menyentuh di mana saja lalu
 * menggeser mengubah nilai sebanding jarak geser, jadi jari tidak perlu tepat
 * di atas knob dan tidak ada lompatan saat disentuh. Dengan mouse, klik pada
 * trek melompat ke posisi itu (perilaku desktop). Nilai bipolar menempel di
 * nol.
 *
 * Selama disentuh, knob putih berubah menjadi lensa Liquid Glass (iOS 26):
 * kapsul kaca yang memperbesar trek di bawahnya, memanjang menurut kecepatan
 * geser, dan meregang seperti karet di luar rentang lalu memantul balik.
 * Reduce Motion: lensa tetap muncul, tanpa regangan dan karet.
 */
export function Slider({ value, min, max, step, onChange, onInteractionChange, label, valueText, disabled, defaultValue }: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x0: number; v0: number; width: number } | null>(null);
  const pending = useRef<number | null>(null);
  const frame = useRef(0);
  const interacting = useRef(false);
  const interactionCallback = useRef(onInteractionChange);
  interactionCallback.current = onInteractionChange;
  const [active, setActive] = useState(false);
  const [trackWidth, setTrackWidth] = useState(0);
  const reduce = useReducedMotion();

  // Gerak knob: tekan (0..1), geser karet (px), dan regangan dari kecepatan jari.
  const press = useSpring(0, LENS_SPRING);
  const overshoot = useMotionValue(0);
  const pointerX = useMotionValue(0);
  const speed = useSpring(useVelocity(pointerX), { stiffness: 300, damping: 40, mass: 0.5 });
  const stretch = useTransform(speed, (v) => (reduce ? 1 : 1 + Math.min(STRETCH_MAX, Math.abs(v) / STRETCH_SPEED)));
  // Ukuran knob per kepadatan (iOS 24 px -> lensa 36x24; macOS 14 px -> 22x13).
  const dims = useRef(KNOB.compact);
  dims.current = typeof document !== 'undefined' && document.documentElement.dataset.size === 'regular' ? KNOB.regular : KNOB.compact;
  const width = useTransform(press, (p) => dims.current.rest + (dims.current.lensW - dims.current.rest) * p);
  const height = useTransform(press, (p) => dims.current.rest + (dims.current.lensH - dims.current.rest) * p);
  const marginLeft = useTransform(width, (w) => -w / 2);
  const top = useTransform(height, (h) => dims.current.track / 2 - h / 2);
  const scaleX = useTransform([stretch, overshoot], ([s, o]: number[]) => s! * (1 + Math.abs(o!) / 80));
  const scaleY = useTransform(scaleX, (s) => 1 / Math.sqrt(s));
  const solid = useTransform(press, [0, 0.6], [1, 0]);
  const glass = useTransform(press, [0.15, 1], [0, 1]);
  useEffect(() => {
    press.set(active ? 1 : 0);
  }, [active, press]);

  const range = max - min;
  const bipolar = min < 0 && max > 0;
  const frac = Math.min(1, Math.max(0, (value - min) / range));
  const zero = bipolar ? (0 - min) / range : 0;

  const emit = useCallback(
    (v: number) => {
      pending.current = v;
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        if (pending.current !== null) onChange(pending.current);
        pending.current = null;
      });
    },
    [onChange],
  );
  useEffect(() => () => {
    cancelAnimationFrame(frame.current);
    if (interacting.current) interactionCallback.current?.(false);
  }, []);

  const begin = () => {
    if (interacting.current) return;
    interacting.current = true;
    interactionCallback.current?.(true);
    setActive(true);
  };

  const settle = (raw: number) => {
    const detent = bipolar && Math.abs(raw) < range * 0.015 ? 0 : raw;
    return snap(detent, { min, max, step });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    begin();
    let v0 = value;
    if (e.pointerType === 'mouse') {
      const thumbX = rect.left + frac * rect.width;
      if (Math.abs(e.clientX - thumbX) > 16) {
        v0 = settle(min + ((e.clientX - rect.left) / rect.width) * range);
        emit(v0);
      }
    }
    drag.current = { x0: e.clientX, v0, width: rect.width };
    pointerX.jump(e.clientX);
    setTrackWidth(rect.width);
    setActive(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const raw = d.v0 + ((e.clientX - d.x0) / d.width) * range;
    emit(settle(raw));
    pointerX.set(e.clientX);
    if (reduce) return;
    // Di luar rentang: knob ikut jari sedikit, makin berat (karet).
    const over = raw > max ? raw - max : raw < min ? raw - min : 0;
    overshoot.set(over === 0 ? 0 : rubberBand((over / range) * d.width, 36));
  };
  const end = () => {
    if (!interacting.current) return;
    // Pointerup can precede the last animation frame: commit that value
    // before asking the engine to render the full-quality final preview.
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    if (pending.current !== null) onChange(pending.current);
    pending.current = null;
    interacting.current = false;
    drag.current = null;
    setActive(false);
    pointerX.jump(pointerX.get());
    if (overshoot.get() !== 0) animate(overshoot, 0, { type: 'spring', duration: 0.45, bounce: 0.35 });
    interactionCallback.current?.(false);
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
      onChange(snap(next[e.key]!, { min, max, step }));
    }
  };

  const fillFrom = Math.min(frac, zero);
  const fillTo = Math.max(frac, zero);
  return (
    <div
      className="slider"
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={valueText}
      aria-disabled={disabled || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={onKeyDown}
      onKeyUp={end}
      onBlur={end}
      onDoubleClick={() => defaultValue !== undefined && !disabled && onChange(defaultValue)}
    >
      <div ref={trackRef} className="slider-track">
        {bipolar && <span className="slider-zero" style={{ left: `${zero * 100}%` }} />}
        <span className="slider-fill" style={{ left: `${fillFrom * 100}%`, width: `${(fillTo - fillFrom) * 100}%` }} />
        <motion.span
          className="slider-thumb"
          data-active={active || undefined}
          style={{ left: `${frac * 100}%`, x: overshoot, width, height, marginLeft, top, scaleX, scaleY }}
        >
          <motion.span className="slider-thumb-solid" style={{ opacity: solid }} />
          <motion.span className="slider-lens" style={{ opacity: glass }} aria-hidden="true">
            {/* Trek yang sama, diperbesar di sekitar pusat knob: lensa, bukan sekadar kaca buram. */}
            <span
              className="slider-lens-track"
              style={{ width: trackWidth * LENS_ZOOM, left: `calc(50% - ${frac * trackWidth * LENS_ZOOM}px)` }}
            >
              {bipolar && <span className="slider-zero" style={{ left: `${zero * 100}%` }} />}
              <span className="slider-fill" style={{ left: `${fillFrom * 100}%`, width: `${(fillTo - fillFrom) * 100}%` }} />
            </span>
            <span className="slider-lens-sheen" />
          </motion.span>
        </motion.span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

const rollVariants = {
  enter: (dir: number) => ({ y: dir >= 0 ? 10 : -10, opacity: 0, filter: 'blur(2px)' }),
  center: { y: 0, opacity: 1, filter: 'blur(0px)' },
  exit: (dir: number) => ({ y: dir >= 0 ? -10 : 10, opacity: 0, filter: 'blur(2px)' }),
};

export function Stepper({
  label,
  valueText,
  hint,
  onDecrement,
  onIncrement,
  atMin,
  atMax,
  extra,
}: {
  label: string;
  valueText: string;
  hint?: string;
  onDecrement: () => void;
  onIncrement: () => void;
  atMin: boolean;
  atMax: boolean;
  extra?: ReactNode;
}) {
  // Angka bergulir searah tombol yang ditekan (turun: dari atas, naik: dari bawah).
  const direction = useRef(0);
  const reduce = useReducedMotion();
  return (
    <div className="stepper">
      <PressButton className="icon-btn" aria-label={`Decrease ${label}`} disabled={atMin} onClick={() => { direction.current = -1; onDecrement(); }}>
        <Icon name="minus" size={18} strokeWidth={2.6} />
      </PressButton>
      <span className="stepper-value">
        <span className="stepper-roll" aria-live="polite">
          <AnimatePresence initial={false} mode="popLayout" custom={direction.current}>
            <motion.span
              key={valueText}
              className="t-headline tabular"
              custom={direction.current}
              variants={reduce ? undefined : rollVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ type: 'spring', duration: 0.32, bounce: 0.18 }}
            >
              {valueText}
            </motion.span>
          </AnimatePresence>
        </span>
        {hint && <span className="t-footnote secondary" style={{ display: 'block' }}>{hint}</span>}
      </span>
      <PressButton className="icon-btn" aria-label={`Increase ${label}`} disabled={atMax} onClick={() => { direction.current = 1; onIncrement(); }}>
        <Icon name="plus" size={18} strokeWidth={2.6} />
      </PressButton>
      {extra}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function OptionRow({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const reduce = useReducedMotion();
  const mounted = useRef(false);
  useEffect(() => {
    const el = refs.current.get(value);
    if (el) centerInScroller(el);
    // Jelly (React Bits Micro "Jelly Radio"): pilihan mengembang lebar lalu
    // tinggi, tetangga terdorong keluar bertahap lalu kembali.
    if (!mounted.current) { mounted.current = true; return; }
    if (!el || reduce) return;
    animate(el, { scaleX: [1, 1.08, 0.98, 1], scaleY: [1, 0.92, 1.04, 1] }, { duration: 0.45, ease: [0.22, 1, 0.36, 1] });
    const order = options.map((o) => refs.current.get(o.value));
    const at = order.indexOf(el);
    order.forEach((n, i) => {
      if (!n || i === at) return;
      const distance = Math.abs(i - at);
      if (distance > 3) return;
      const push = Math.sign(i - at) * (4 - distance) * 1.5;
      animate(n, { x: [0, push, 0] }, { duration: 0.42, delay: distance * 0.035, ease: [0.22, 1, 0.36, 1] });
    });
    // `options` berganti identitas tiap render; hanya pilihan yang memicu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div role="group" aria-label={label} className="options scroll-x">
      {options.map((o) => (
        <button
          key={o.value}
          ref={(el) => {
            if (el) refs.current.set(o.value, el);
            else refs.current.delete(o.value);
          }}
          type="button"
          className="option"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Pop-up button macOS (select asli, jadi keyboard dan VoiceOver bawaan):
 * pilihan pendek di inspector layar lebar, rata kanan di baris label.
 */
export function PopUp({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <span className="popup">
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <Icon name="upDown" size={11} strokeWidth={2.4} />
    </span>
  );
}

// ---------------------------------------------------------------------------

type PressButtonProps = React.ComponentProps<typeof motion.button>;

/**
 * Tombol dengan umpan balik tekan: turun cepat (0,08 s) saat disentuh, naik
 * dengan pegas sedikit memantul saat dilepas, seperti tombol iOS.
 */
export function PressButton({ children, type = 'button', ...rest }: PressButtonProps) {
  return (
    <motion.button
      type={type}
      whileTap={rest.disabled ? undefined : { scale: pressScale, transition: { duration: 0.08, ease: 'easeOut' } }}
      transition={pressRelease}
      {...rest}
    >
      {children}
    </motion.button>
  );
}
