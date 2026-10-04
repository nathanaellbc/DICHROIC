/**
 * Latar titik interaktif untuk layar awal, ditulis ulang dari gagasan "Dot
 * Grid" React Bits tanpa GSAP: kanvas 2D (bukan konteks WebGL kedua di
 * samping pipeline WebGPU). Titik di dekat penunjuk menyala biru dan sedikit
 * terdorong; sapuan diagonal berkala memberi gerak saat tidak ada penunjuk
 * (HP). Hanya menggambar selama ada yang berubah, berhenti saat tab
 * tersembunyi, dan statis dengan Reduce Motion.
 */
import { useEffect, useRef } from 'react';

const BASE = [255, 255, 255] as const;
const ACCENT = [0, 145, 255] as const;
const SWEEP_TRAVEL_MS = 3600;
const SWEEP_PERIOD_MS = 7200;

export function DotField({ active = false, className }: { active?: boolean; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activeRef = useRef(active);
  const wakeRef = useRef<() => void>(() => {});

  useEffect(() => {
    activeRef.current = active;
    wakeRef.current();
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !host || !ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let width = 0;
    let height = 0;
    let spacing = 24;
    let dots: Float32Array = new Float32Array(0);
    const pointer = { x: -9999, y: -9999, strength: 0, target: 0, lastMove: 0 };
    let glow = activeRef.current ? 1 : 0;
    let frame = 0;
    const start = performance.now();

    const layout = () => {
      const rect = host.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      spacing = width < 600 ? 22 : 26;
      const cols = Math.ceil(width / spacing) + 1;
      const rows = Math.ceil(height / spacing) + 1;
      const offX = (width - (cols - 1) * spacing) / 2;
      const offY = (height - (rows - 1) * spacing) / 2;
      dots = new Float32Array(cols * rows * 2);
      let i = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          dots[i++] = offX + c * spacing;
          dots[i++] = offY + r * spacing;
        }
      }
    };

    const draw = (now: number): boolean => {
      // Penunjuk dan sorotan seret bergerak menuju targetnya (tanpa lompatan).
      pointer.strength += (pointer.target - pointer.strength) * 0.12;
      glow += ((activeRef.current ? 1 : 0) - glow) * 0.1;

      const t = now - start;
      const phase = t % SWEEP_PERIOD_MS;
      const sweeping = !reduced && phase < SWEEP_TRAVEL_MS;
      const diag = width + height;
      const band = sweeping ? (phase / SWEEP_TRAVEL_MS) * (diag + 360) - 180 : -9999;
      const radius = width < 600 ? 120 : 160;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = `rgba(${BASE[0]},${BASE[1]},${BASE[2]},${0.15 + glow * 0.08})`;
      ctx.beginPath();
      const lit: number[] = [];
      for (let i = 0; i < dots.length; i += 2) {
        let x = dots[i]!;
        let y = dots[i + 1]!;
        let k = glow * 0.35;
        if (pointer.strength > 0.01) {
          const dx = x - pointer.x;
          const dy = y - pointer.y;
          const d = Math.hypot(dx, dy);
          if (d < radius) {
            const p = (1 - d / radius) ** 2 * pointer.strength;
            k = Math.max(k, p);
            if (d > 0.001) {
              x += (dx / d) * p * 7;
              y += (dy / d) * p * 7;
            }
          }
        }
        if (sweeping) {
          const s = 1 - Math.abs(x + y - band) / 180;
          if (s > 0) k = Math.max(k, s * s * 0.55);
        }
        if (k < 0.04) {
          ctx.moveTo(x + 1, y);
          ctx.arc(x, y, 1, 0, Math.PI * 2);
        } else {
          lit.push(x, y, k);
        }
      }
      ctx.fill();
      for (let i = 0; i < lit.length; i += 3) {
        const k = Math.min(1, lit[i + 2]!);
        const r = Math.round(BASE[0] + (ACCENT[0] - BASE[0]) * k);
        const g = Math.round(BASE[1] + (ACCENT[1] - BASE[1]) * k);
        const b = Math.round(BASE[2] + (ACCENT[2] - BASE[2]) * k);
        ctx.fillStyle = `rgba(${r},${g},${b},${0.14 + k * 0.8})`;
        ctx.beginPath();
        ctx.arc(lit[i]!, lit[i + 1]!, 1 + k * 1.3, 0, Math.PI * 2);
        ctx.fill();
      }

      const settling = Math.abs(pointer.target - pointer.strength) > 0.005 || Math.abs((activeRef.current ? 1 : 0) - glow) > 0.005;
      return sweeping || settling || now - pointer.lastMove < 400;
    };

    const tick = (now: number) => {
      frame = 0;
      if (document.hidden) return;
      if (draw(now)) frame = requestAnimationFrame(tick);
      else if (!reduced) {
        // Diam sampai sapuan berikutnya.
        const wait = SWEEP_PERIOD_MS - ((now - start) % SWEEP_PERIOD_MS);
        idle = window.setTimeout(wake, wait);
      }
    };
    let idle = 0;
    const wake = () => {
      window.clearTimeout(idle);
      if (!frame && !document.hidden) frame = requestAnimationFrame(tick);
    };
    wakeRef.current = wake;

    const onMove = (e: PointerEvent) => {
      const rect = host.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
      const inside = pointer.x >= 0 && pointer.y >= 0 && pointer.x <= rect.width && pointer.y <= rect.height;
      pointer.target = inside ? 1 : 0;
      pointer.lastMove = performance.now();
      wake();
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') onLeave();
    };
    const onLeave = () => {
      pointer.target = 0;
      pointer.lastMove = performance.now();
      wake();
    };

    layout();
    const observer = new ResizeObserver(() => {
      layout();
      wake();
    });
    observer.observe(host);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);
    window.addEventListener('pointerup', onUp, { passive: true });
    window.addEventListener('pointercancel', onUp, { passive: true });
    window.addEventListener('dragover', onMove as unknown as (e: DragEvent) => void, { passive: true });
    document.addEventListener('visibilitychange', wake);
    wake();

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(idle);
      observer.disconnect();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onMove);
      document.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('dragover', onMove as unknown as (e: DragEvent) => void);
      document.removeEventListener('visibilitychange', wake);
      wakeRef.current = () => {};
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
