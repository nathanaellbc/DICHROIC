import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';

/* ══ Image compare ════════════════════════════════════════
   One picture, two states of it, and a line to drag across.
   Left of the line is the raw shot, right of it the edit. Drag
   slowly and it stays where you leave it; flick it and it
   glides to the edge you threw it at.

   ── TWO PICTURES, ONE FRAME ─────────────────────────────
   The original and the film render are the same scene at the
   same size, so the two halves line up exactly and the line
   reads as seeing through the picture.

   ── THE LINE IS JELLY ───────────────────────────────────
   The knob is exactly where the finger is; the two ends of the
   line are not. They follow it on an under-damped spring, so a
   hard swing leaves them behind and the line bows into a curve,
   then wobbles straight when you stop. The before layer is cut
   along the SAME curve — clip-path: path(), in the block's own
   pixels — so the picture's edge bends with the line rather than
   the line bending over a straight cut.

   ── IN THIS PROJECT ─────────────────────────────────────
   (Diadaptasi dari Bencho.) Foto bisa di-zoom dan digeser, dan
   PhotoView yang memegang pointer (supaya pinch tetap jalan), jadi
   geraknya ada di hook `useImageCompare`, garis dan knob di
   `ImageCompare`, dan potongan lapisan "before" di `compareCut`
   yang dipasang PhotoView di dalam lapisan zoom. */

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export type CompareState = ReturnType<typeof useImageCompare>;

/** `width`: lebar foto di layar (px), untuk seberapa jauh garis boleh melengkung. */
export function useImageCompare(width: number) {
  const [p, setP] = useState(0.5);
  const [bend, setBend] = useState(0);
  const cur = useRef(0.5);
  const target = useRef<number | null>(null);
  /* the ends of the line, and how fast they are moving */
  const ends = useRef({ x: 0.5, v: 0 });
  const raf = useRef(0);
  const drag = useRef<{ v: number; t: number; last: number } | null>(null);
  const [held, setHeld] = useState(false);
  const W = useRef(width);
  useEffect(() => { W.current = width; }, [width]);

  /* one loop for both motions: the glide toward a target, and
     the ends catching up with the middle. It stops itself once
     everything is still. */
  const loop = () => {
    if (raf.current) return;
    let prev = performance.now();
    const step = (t: number) => {
      const dt = Math.min(0.033, (t - prev) / 1000);
      prev = t;
      if (target.current !== null) {
        cur.current += (target.current - cur.current) * (1 - Math.pow(0.0004, dt));
        if (Math.abs(target.current - cur.current) < 0.0005) { cur.current = target.current; target.current = null; }
      }
      /* the jelly: a spring from the ends to the middle, damped
         firmly enough that it flexes and settles without a wobble */
      const e = ends.current;
      e.v += ((cur.current - e.x) * 620 - e.v * 44) * dt;
      e.x += e.v * dt;
      setP(cur.current);
      setBend(clamp((cur.current - e.x) * W.current * 0.5, -9, 9));
      const still = target.current === null && Math.abs(cur.current - e.x) < 0.0006 && Math.abs(e.v) < 0.002;
      if (still) { e.x = cur.current; e.v = 0; setBend(0); raf.current = 0; return; }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };
  const glide = (to: number) => { target.current = to; loop(); };
  /* under the finger: the knob is drawn this frame, not the next —
     only the ends are left to the loop */
  const place = (v: number) => { target.current = null; cur.current = v; setP(v); loop(); };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return {
    p,
    bend,
    held,
    /** Jari turun di `v` (0..1): garis meluncur ke sana. */
    press(v: number) {
      drag.current = { v: 0, t: performance.now(), last: v };
      setHeld(true);
      glide(v);
    },
    move(v: number) {
      const d = drag.current;
      if (!d) return;
      const now = performance.now();
      d.v = (v - d.last) / Math.max(1, now - d.t);
      d.t = now;
      d.last = v;
      place(v);
    },
    release() {
      const d = drag.current;
      drag.current = null;
      setHeld(false);
      /* a flick carries it to the edge it was thrown at */
      if (d && Math.abs(d.v) > 0.0025) {
        glide(d.v > 0 ? 1 : 0);
      }
    },
    /** Seret batal (pinch, pointercancel): garis tetap di tempatnya. */
    cancel() { drag.current = null; setHeld(false); },
    onKeyDown(e: KeyboardEvent) {
      const from = target.current ?? cur.current;
      const to: Record<string, number> = { ArrowLeft: from - 0.1, ArrowDown: from - 0.1, ArrowRight: from + 0.1, ArrowUp: from + 0.1, Home: 0, End: 1 };
      if (!(e.key in to)) return;
      e.preventDefault();
      e.stopPropagation();
      glide(clamp(to[e.key]!, 0, 1));
    },
  };
}

/**
 * Potongan lapisan "before" dalam piksel lapisannya sendiri (lebar `width`,
 * tinggi `height`, belum diskalakan zoom). `scale` = zoom, karena lengkungnya
 * diukur di layar.
 */
export function compareCut({ p, bend }: CompareState, width: number, height: number, scale = 1): string {
  /* the line as a curve: ends at x - bend, and a control point at
     x + bend so the curve passes exactly through the knob */
  const x = p * width;
  const b = bend / scale;
  const top = x - b;
  return `path("M 0 0 L ${top.toFixed(2)} 0 Q ${(x + b).toFixed(2)} ${height / 2} ${top.toFixed(2)} ${height} L 0 ${height} Z")`;
}

/**
 * Garis, knob, dan label Before/After. Mengisi kotak induknya (`bounds`);
 * `photo` = posisi foto di kotak itu sekarang (ikut zoom/geser).
 */
export function ImageCompare({
  state,
  photo,
  bounds,
  /* show the Before and After tags */
  labels = true,
}: {
  state: CompareState;
  photo: { x: number; y: number; width: number; height: number };
  bounds: { width: number; height: number };
  labels?: boolean;
}) {
  const { p, bend, held } = state;
  const x = photo.x + p * photo.width;
  const top = x - bend;
  const y0 = photo.y;
  const y1 = photo.y + photo.height;
  const curve = `M ${top.toFixed(2)} ${y0.toFixed(2)} Q ${(x + bend).toFixed(2)} ${((y0 + y1) / 2).toFixed(2)} ${top.toFixed(2)} ${y1.toFixed(2)}`;
  // Tag dan knob tetap di bagian foto yang terlihat walau di-zoom.
  const left = Math.max(photo.x, 0) + 12;
  const right = bounds.width - Math.min(photo.x + photo.width, bounds.width) + 12;
  const tagTop = Math.max(photo.y, 0) + 12;
  const knobY = clamp((y0 + y1) / 2, 18, bounds.height - 18);

  return (
    <div
      className="cmp"
      data-held={held || undefined}
      role="slider"
      tabIndex={0}
      aria-label="Before and after"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(p * 100)}
      aria-valuetext={`${Math.round(p * 100)}% original`}
      onKeyDown={state.onKeyDown}
      // Kotak foto, bukan bingkai sendiri: foto yang di-zoom boleh melewati tepinya.
      style={{ position: 'absolute', inset: 0, overflow: 'visible', background: 'none', '--p': p } as CSSProperties}
    >
      {labels && (
        <>
          <span className="cmp-tag" style={{ top: tagTop, left, opacity: clamp((p - 0.14) * 4, 0, 1) }}>Before</span>
          <span className="cmp-tag cmp-right" style={{ top: tagTop, right, opacity: clamp((0.86 - p) * 4, 0, 1) }}>After</span>
        </>
      )}
      <svg className="cmp-line" width={bounds.width} height={bounds.height} viewBox={`0 0 ${bounds.width} ${bounds.height}`} aria-hidden="true">
        <path d={curve} />
      </svg>
      <span className="cmp-grip" style={{ left: x }}>
        <span className="cmp-knob" style={{ top: knobY }}>
          <svg width="16" height="10" viewBox="0 0 16 10" aria-hidden="true">
            <path d="M5 1 1 5l4 4M11 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </span>
    </div>
  );
}
