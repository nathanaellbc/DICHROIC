/**
 * Lup pipet putih (seperti pipet iOS/Lightroom): lingkaran berisi piksel
 * foto yang diperbesar dengan crosshair di tengah; cincinnya berwarna piksel
 * yang dibidik. Di HP lup melayang di atas jari (jari menutupi titiknya),
 * dengan crosshair kecil tepat di titik sentuh; dengan mouse lup di samping
 * kursor.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import type { Frame } from '../engine/display';

/** Diameter lup (px CSS) dan jumlah piksel foto yang tampil melintangnya. */
const SIZE = 118;
const SPAN = 15;
/** Jarak pusat lup dari jari (px CSS). */
const LIFT = 96;

/** Kanvas sumber sekali per frame (bukan per gerakan). */
function useFrameCanvas(frame: Frame | undefined): HTMLCanvasElement | undefined {
  return useMemo(() => {
    if (!frame || typeof document === 'undefined') return undefined;
    const c = document.createElement('canvas');
    c.width = frame.width;
    c.height = frame.height;
    c.getContext('2d', { colorSpace: frame.colorSpace })
      ?.putImageData(new ImageData(new Uint8ClampedArray(frame.pixels), frame.width, frame.height, { colorSpace: frame.colorSpace }), 0, 0);
    return c;
  }, [frame]);
}

export interface LoupeTarget {
  /** Titik di area foto (px CSS, relatif area). */
  x: number;
  y: number;
  /** Titik di foto 0..1. */
  u: number;
  v: number;
  touch: boolean;
}

export function Loupe({ frame, target, area }: { frame: Frame | undefined; target: LoupeTarget; area: { width: number; height: number } }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const source = useFrameCanvas(frame);
  const inside = target.u >= 0 && target.u <= 1 && target.v >= 0 && target.v <= 1;

  // Warna piksel yang dibidik (cincin lup).
  let ring = 'rgba(255,255,255,0.9)';
  if (frame && inside) {
    const px = Math.min(frame.width - 1, Math.floor(target.u * frame.width));
    const py = Math.min(frame.height - 1, Math.floor(target.v * frame.height));
    const i = (py * frame.width + px) * 4;
    ring = `rgb(${frame.pixels[i]}, ${frame.pixels[i + 1]}, ${frame.pixels[i + 2]})`;
  }

  useLayoutEffect(() => {
    const c = canvas.current;
    if (!c || !frame || !source) return;
    const dpr = window.devicePixelRatio || 1;
    const size = Math.round(SIZE * dpr);
    if (c.width !== size) { c.width = size; c.height = size; }
    const ctx = c.getContext('2d', { colorSpace: frame.colorSpace });
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    // SPAN piksel foto berpusat di piksel yang dibidik.
    const cx = Math.floor(target.u * frame.width), cy = Math.floor(target.v * frame.height);
    const half = Math.floor(SPAN / 2), cell = size / SPAN;
    ctx.drawImage(source, cx - half, cy - half, SPAN, SPAN, 0, 0, size, size);
    // Crosshair: kotak piksel tengah + garis tipis.
    const mid = half * cell;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeRect(mid - ctx.lineWidth, mid - ctx.lineWidth, cell + 2 * ctx.lineWidth, cell + 2 * ctx.lineWidth);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(mid, mid, cell, cell);
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, mid - 2 * dpr);
    ctx.moveTo(size / 2, mid + cell + 2 * dpr); ctx.lineTo(size / 2, size);
    ctx.moveTo(0, size / 2); ctx.lineTo(mid - 2 * dpr, size / 2);
    ctx.moveTo(mid + cell + 2 * dpr, size / 2); ctx.lineTo(size, size / 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }, [frame, source, target.u, target.v]);

  // Posisi: di atas jari (sentuh) atau kanan-atas kursor; tetap di dalam area, pindah ke bawah bila mepet atas.
  let lx = target.touch ? target.x : target.x + 70;
  let ly = target.touch ? target.y - LIFT : target.y - 70;
  if (ly - SIZE / 2 < 4) ly = target.touch ? target.y + LIFT : target.y + 70;
  lx = Math.min(area.width - SIZE / 2 - 4, Math.max(SIZE / 2 + 4, lx));
  ly = Math.min(area.height - SIZE / 2 - 4, Math.max(SIZE / 2 + 4, ly));

  return (
    <>
      {target.touch && (
        // Crosshair kecil tepat di titik sentuh (terlihat di tepi jari).
        <span className="loupe-point" aria-hidden="true" style={{ left: target.x, top: target.y }} />
      )}
      <div className="loupe" aria-hidden="true" style={{ left: lx - SIZE / 2, top: ly - SIZE / 2, width: SIZE, height: SIZE, ['--loupe-ring' as string]: ring }}>
        <canvas ref={canvas} />
      </div>
    </>
  );
}
