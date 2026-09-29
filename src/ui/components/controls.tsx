/**
 * Kontrol standar bergaya iOS: segmented control, switch, slider, stepper,
 * dan baris pilihan kapsul. Semuanya elemen asli (`button`, role ARIA yang
 * tepat) supaya bisa dipakai dengan VoiceOver dan keyboard.
 */
import { motion } from 'motion/react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { pressScale, snappy } from '../motion';
import { snap } from '../model/tools';
import { Icon } from './Icon';

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
  const pillId = useId();
  return (
    <div role="group" aria-label={label} className={small ? 'segmented small' : 'segmented'}>
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button key={item.value} type="button" className="segment" aria-pressed={selected} onClick={() => onChange(item.value)}>
            {selected && <motion.span layoutId={pillId} className="segment-pill" transition={snappy} />}
            <span className="segment-label">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
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
  return (
    <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}>
      <motion.span className="switch-knob" initial={false} animate={{ x: checked ? 20 : 0 }} transition={snappy} />
    </button>
  );
}

// ---------------------------------------------------------------------------

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  label: string;
  valueText: string;
  disabled?: boolean;
  /** Nilai yang dipulihkan dengan ketuk dua kali. */
  defaultValue?: number;
}

/**
 * Slider dengan seret RELATIF (seperti Photos): menyentuh di mana saja lalu
 * menggeser mengubah nilai sebanding jarak geser, jadi jari tidak perlu tepat
 * di atas knob dan tidak ada lompatan saat disentuh. Dengan mouse, klik pada
 * trek melompat ke posisi itu (perilaku desktop). Nilai bipolar menempel di
 * nol. Knob menjadi kaca selama disentuh (DESIGN.md, Liquid Glass: kontrol).
 */
export function Slider({ value, min, max, step, onChange, label, valueText, disabled, defaultValue }: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x0: number; v0: number; width: number } | null>(null);
  const pending = useRef<number | null>(null);
  const frame = useRef(0);
  const [active, setActive] = useState(false);

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
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const settle = (raw: number) => {
    const detent = bipolar && Math.abs(raw) < range * 0.015 ? 0 : raw;
    return snap(detent, { min, max, step });
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || !trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    let v0 = value;
    if (e.pointerType === 'mouse') {
      const thumbX = rect.left + frac * rect.width;
      if (Math.abs(e.clientX - thumbX) > 16) {
        v0 = settle(min + ((e.clientX - rect.left) / rect.width) * range);
        emit(v0);
      }
    }
    drag.current = { x0: e.clientX, v0, width: rect.width };
    setActive(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    emit(settle(d.v0 + ((e.clientX - d.x0) / d.width) * range));
  };
  const end = () => {
    drag.current = null;
    setActive(false);
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
      onKeyDown={onKeyDown}
      onDoubleClick={() => defaultValue !== undefined && !disabled && onChange(defaultValue)}
    >
      <div ref={trackRef} className="slider-track">
        {bipolar && <span className="slider-zero" style={{ left: `${zero * 100}%` }} />}
        <span className="slider-fill" style={{ left: `${fillFrom * 100}%`, width: `${(fillTo - fillFrom) * 100}%` }} />
        <motion.span
          className="slider-thumb"
          style={{ left: `${frac * 100}%` }}
          initial={false}
          animate={
            active
              ? { scale: 1.2, backgroundColor: 'rgba(255,255,255,0.5)', boxShadow: '0 0 0 1px rgba(255,255,255,0.85), 0 4px 14px rgba(0,0,0,0.35)' }
              : { scale: 1, backgroundColor: 'rgba(255,255,255,1)', boxShadow: '0 0 0 0px rgba(255,255,255,0), 0 3px 8px rgba(0,0,0,0.35)' }
          }
          transition={snappy}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

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
  return (
    <div className="stepper">
      <PressButton className="icon-btn" aria-label={`Decrease ${label}`} disabled={atMin} onClick={onDecrement}>
        <Icon name="minus" size={18} strokeWidth={2.6} />
      </PressButton>
      <span className="stepper-value">
        <span className="t-headline tabular" aria-live="polite">{valueText}</span>
        {hint && <span className="t-footnote secondary" style={{ display: 'block' }}>{hint}</span>}
      </span>
      <PressButton className="icon-btn" aria-label={`Increase ${label}`} disabled={atMax} onClick={onIncrement}>
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
  useEffect(() => {
    refs.current.get(value)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
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

type PressButtonProps = React.ComponentProps<typeof motion.button>;

/** Tombol dengan umpan balik tekan singkat (skala 0.94). */
export function PressButton({ children, type = 'button', ...rest }: PressButtonProps) {
  return (
    <motion.button type={type} whileTap={rest.disabled ? undefined : { scale: pressScale }} transition={snappy} {...rest}>
      {children}
    </motion.button>
  );
}
