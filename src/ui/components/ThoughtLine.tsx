/**
 * Baris status proses bergaya "Thought Line" (React Bits Micro), ditulis
 * ulang tanpa dependensi ikon tambahan:
 *
 * - selama bekerja: glyph dan label "bernapas" (opacity), label berkilau
 *   (shimmer), jam berjalan 0.1 s, dan langkah-langkah muncul di bawahnya
 *   (yang sudah lewat dicentang, yang aktif berdenyut);
 * - selesai: label berganti dengan blur-crossfade menjadi "Developed in",
 *   jam meluncur ke ujung label baru dan berhenti, jejak langkah terlipat.
 *
 * Reduce Motion: status dan timer tetap ada, animasi dekoratif dimatikan.
 */
import { animate, useReducedMotion } from 'motion/react';
import type { AnimationPlaybackControls } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import type { UiIconName } from './Icon';

const EASE_IN_OUT: [number, number, number, number] = [0.77, 0, 0.175, 1];
const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1];

/** Desidetik -> "4.2s" / "1m 3.0s". */
export function formatElapsed(ds: number): string {
  return ds < 600 ? `${(ds / 10).toFixed(1)}s` : `${Math.floor(ds / 600)}m ${((ds % 600) / 10).toFixed(1)}s`;
}

export interface ThoughtLineProps {
  working: boolean;
  label: string;
  doneLabel: string;
  steps: readonly string[];
  /** Indeks langkah yang sedang berjalan; sebelumnya dicentang. */
  activeStep: number;
  glyph?: UiIconName;
  hideHead?: boolean;
}

export function ThoughtLine({ working, label, doneLabel, steps, activeStep, glyph = 'aperture', hideHead = false }: ThoughtLineProps) {
  const reduce = useReducedMotion();
  const glyphRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<HTMLSpanElement>(null);
  const stackRef = useRef<HTMLSpanElement>(null);
  const workRef = useRef<HTMLSpanElement>(null);
  const doneRef = useRef<HTMLSpanElement>(null);
  const ds = useRef(0);
  const [announce, setAnnounce] = useState(label);

  // Napas glyph selagi bekerja; mengendap di 0,55 saat selesai.
  useEffect(() => {
    if (hideHead) return undefined;
    const el = glyphRef.current;
    if (!el) return undefined;
    if (reduce) {
      el.style.opacity = working ? '0.8' : '0.55';
      return undefined;
    }
    let loop: AnimationPlaybackControls | undefined;
    let alive = true;
    const depth = 0.45;
    const lead = working
      ? animate(el, { opacity: 1 - depth }, { duration: 0.2, ease: EASE_OUT })
      : animate(el, { opacity: 0.55 }, { duration: 0.35, ease: EASE_OUT });
    if (working) {
      void lead.then(() => {
        if (alive) loop = animate(el, { opacity: [1 - depth, 1, 1 - depth] }, { duration: 1.6, ease: EASE_IN_OUT, repeat: Infinity });
      });
    }
    return () => { alive = false; lead.stop(); loop?.stop(); };
  }, [working, reduce, hideHead]);

  // Jam: ditulis langsung ke DOM tiap 100 ms (tanpa render React).
  useLayoutEffect(() => {
    if (hideHead || !working) return undefined;
    const start = performance.now();
    const paint = () => {
      ds.current = Math.floor((performance.now() - start) / 100);
      if (timerRef.current) timerRef.current.textContent = formatElapsed(ds.current);
    };
    paint();
    const id = window.setInterval(paint, 100);
    return () => window.clearInterval(id);
  }, [working, hideHead]);

  // Jam menempel di ujung label yang aktif; meluncur saat label berganti.
  const wasWorking = useRef(working);
  useLayoutEffect(() => {
    if (hideHead) return;
    const t = timerRef.current, stack = stackRef.current;
    const active = working ? workRef.current : doneRef.current;
    if (!t || !stack || !active) return;
    const glide = wasWorking.current !== working;
    wasWorking.current = working;
    if (!glide) t.style.transition = 'none';
    t.style.transform = `translateX(${active.offsetWidth - stack.offsetWidth}px)`;
    if (!glide) { void t.offsetWidth; t.style.transition = ''; }
  }, [working, label, doneLabel, hideHead]);

  useEffect(() => {
    setAnnounce(working ? label : `${doneLabel} ${formatElapsed(ds.current)}`);
  }, [working, label, doneLabel]);

  return (
    <div
      className="thought-line"
      data-testid="thought-line"
      data-working={working || undefined}
      data-shimmer={(working && !reduce) || undefined}
      data-hide-head={hideHead || undefined}
    >
      {!hideHead && (
        <div className="thought-line-head" aria-hidden="true">
          <span ref={glyphRef} className="thought-line-glyph"><Icon name={glyph} size={17} strokeWidth={2.2} /></span>
          <span ref={stackRef} className="thought-line-label">
            <span ref={workRef} className="thought-line-text" data-active={working || undefined}>
              <span className="thought-line-breath">{label}</span>
            </span>
            <span ref={doneRef} className="thought-line-text thought-line-done" data-active={!working || undefined}>{doneLabel}</span>
          </span>
          <span ref={timerRef} className="thought-line-timer tabular">0.0s</span>
        </div>
      )}
      <div className="thought-line-trace" data-open={working || undefined}>
        <div className="thought-line-fold">
          {steps.slice(0, Math.max(1, activeStep + 1)).map((text, i) => {
            const done = !working || i < activeStep;
            return (
              <div key={i} className="thought-line-step" data-done={done || undefined}>
                <span className="thought-line-mark" aria-hidden="true">
                  {done ? <Icon name="check" size={13} strokeWidth={3} /> : <i className="thought-line-pulse" />}
                </span>
                <span>{text}</span>
              </div>
            );
          })}
        </div>
      </div>
      <span className="sr-only" role="status">{announce}</span>
    </div>
  );
}
