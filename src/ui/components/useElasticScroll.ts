import { animate, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { useCallback, useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { photoReturn, snappy } from '../motion';

function scrollLimit(el: HTMLDivElement): number {
  const track = el.firstElementChild as HTMLElement | null;
  const style = getComputedStyle(el);
  // Transformed overflow changes scrollWidth; measure the untransformed track
  // so rubber-banding cannot move the boundary it is returning to.
  return Math.max(0, (track?.offsetWidth ?? 0) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) - el.clientWidth);
}

/** Native scroll coordinates for wheels/focus, with pointer rubber-banding. */
export function useElasticScroll() {
  const ref = useRef<HTMLDivElement>(null);
  const offset = useMotionValue(0);
  const transform = useTransform(offset, (x) => `translateX(${x}px)`);
  const reduce = useReducedMotion();
  const animation = useRef<ReturnType<typeof animate> | null>(null);
  const grip = useRef<{ id: number; x: number; y: number; start: number; lastX: number; time: number; velocity: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const position = useMotionValue(0);

  useEffect(() => position.on('change', (value) => {
    const el = ref.current;
    if (!el) return;
    const max = scrollLimit(el);
    const clamped = Math.max(0, Math.min(max, value));
    el.scrollLeft = clamped;
    const excess = clamped - value;
    const limit = Math.max(1, el.clientWidth * 0.25);
    offset.set(reduce ? 0 : excess * 0.55 / (1 + Math.abs(excess) * 0.55 / limit));
  }), [position, offset, reduce]);
  useEffect(() => () => { animation.current?.stop(); }, []);
  const reset = useCallback(() => {
    animation.current?.stop();
    grip.current = null;
    offset.set(0);
  }, [offset]);

  const finish = (e: ReactPointerEvent<HTMLDivElement>, canceled = false) => {
    const g = grip.current;
    if (!g || g.id !== e.pointerId) return;
    grip.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (!g.moved) return;
    const el = e.currentTarget;
    const max = scrollLimit(el);
    const current = position.get();
    const outside = current < 0 || current > max;
    const velocity = canceled || performance.now() - g.time > 80 ? 0 : g.velocity;
    const target = Math.max(0, Math.min(max, current + (outside || reduce ? 0 : velocity * 0.15)));
    if (reduce) position.set(target);
    else animation.current = animate(position, target, outside ? photoReturn : snappy);
  };

  return {
    ref,
    reset,
    transform,
    handlers: {
      onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
        if (!e.isPrimary || e.button !== 0) return;
        animation.current?.stop();
        suppressClick.current = false;
        const el = e.currentTarget;
        // Invert rubber-banding so interrupting the return does not jump.
        const limit = Math.max(1, el.clientWidth * 0.25);
        const rubber = offset.get();
        const excess = rubber / (0.55 * Math.max(0.01, 1 - Math.abs(rubber) / limit));
        const start = el.scrollLeft - excess;
        position.set(start);
        grip.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start, lastX: e.clientX, time: performance.now(), velocity: 0, moved: false };
      },
      onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
        const g = grip.current;
        if (!g || g.id !== e.pointerId) return;
        const dx = e.clientX - g.x;
        if (!g.moved) {
          if (Math.abs(dx) < 8) return;
          if (Math.abs(e.clientY - g.y) > Math.abs(dx)) { grip.current = null; return; }
          g.moved = true;
          suppressClick.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.scrollTo({ left: e.currentTarget.scrollLeft, behavior: 'instant' });
        }
        e.preventDefault();
        const now = performance.now();
        g.velocity = (g.lastX - e.clientX) * 1000 / Math.max(1, now - g.time);
        g.lastX = e.clientX;
        g.time = now;
        position.set(g.start - dx);
      },
      onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => finish(e),
      onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => finish(e, true),
      onLostPointerCapture: (e: ReactPointerEvent<HTMLDivElement>) => {
        // Touch implicitly captures the button first; transferring that capture
        // to the row bubbles a loss from the child, not the end of our drag.
        if (e.target === e.currentTarget) finish(e, true);
      },
      onClickCapture: (e: ReactMouseEvent<HTMLDivElement>) => {
        if (suppressClick.current && e.detail !== 0) { e.preventDefault(); e.stopPropagation(); }
      },
      onWheel: () => { animation.current?.stop(); offset.set(0); },
    },
  };
}
