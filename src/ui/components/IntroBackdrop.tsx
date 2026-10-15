/**
 * Kanvas latar untuk kaca intro (GlassSurface mode WebGL). WebGL tidak bisa
 * membaca isi halaman, jadi semua yang ada di belakang kaca -- warna latar,
 * cahaya langit, bintang, wordmark, dan stiker -- digambar ulang di sini
 * dari data yang sama dengan DOM-nya, hanya bila isinya di area kaca berubah. Kanvas tidak terlihat
 * (`visibility: hidden`); hanya dipakai sebagai tekstur, jadi kaca tampil
 * sama di Chrome dan Safari/iOS. Kanvas hanya menutupi area di sekitar kaca
 * (bukan seluruh layar) supaya gambar ulang dan unggah tekstur per frame murah.
 */
import { useEffect } from 'react';
import type { RefObject } from 'react';
import { STARS } from './StarField';

/** Jarak di luar kaca yang ikut digambar (px), untuk sampel pembiasan di tepi. */
const MARGIN = 24;

/** Area kanvas dalam koordinat panggung (px CSS). */
export interface BackdropArea { x0: number; y0: number; x1: number; y1: number }

/**
 * Lapisan tambahan (stiker). `key` meringkas isi lapisan yang masuk area --
 * kanvas (dan shader kaca) hanya digambar ulang bila ada kunci yang berubah.
 */
export interface BackdropLayer {
  key(area: BackdropArea): string;
  paint(ctx: CanvasRenderingContext2D, ratio: number, area: BackdropArea): void;
}

const layers = new Set<BackdropLayer>();

export function addBackdropLayer(layer: BackdropLayer) {
  layers.add(layer);
  return () => { layers.delete(layer); };
}

export function IntroBackdrop({ canvasRef }: { canvasRef: RefObject<HTMLCanvasElement | null> }) {
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = canvas?.parentElement;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !stage || !ctx) return undefined;
    let raf = 0, frame = 0, version = 0;
    let background = '', star = '', dark = false, placed = '', drawn = '';

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const w = stage.clientWidth, h = stage.clientHeight;
      const glass = stage.querySelector('.intro-glass');
      if (!w || !h || !glass) return;
      // Area kaca (+ margin) dalam koordinat panggung, dipotong tepi panggung.
      const origin = stage.getBoundingClientRect(), box = glass.getBoundingClientRect();
      const area = {
        x0: Math.max(0, Math.floor(box.left - origin.left - MARGIN)), y0: Math.max(0, Math.floor(box.top - origin.top - MARGIN)),
        x1: Math.min(w, Math.ceil(box.right - origin.left + MARGIN)), y1: Math.min(h, Math.ceil(box.bottom - origin.top + MARGIN)),
      };
      const { x0, y0, x1, y1 } = area;
      if (x1 <= x0 || y1 <= y0) return;
      // Gaya tema dibaca ulang sesekali (ganti tema terang/gelap), bukan tiap frame.
      if (frame++ % 30 === 0) {
        background = getComputedStyle(stage).backgroundColor;
        const sky = stage.querySelector<HTMLElement>('.intro-sky');
        star = (sky && getComputedStyle(sky).getPropertyValue('--intro-star').trim()) || '255, 255, 255';
        dark = star.startsWith('255');
      }
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const word = wordmarkState(stage, origin, area);
      const keys = [...layers].map((layer) => layer.key(area));
      const signature = [x0, y0, x1, y1, w, h, ratio, background, star, word?.key ?? '', ...keys].join('|');
      if (signature === drawn) return;
      drawn = signature;

      const place = `${x0}|${y0}|${x1 - x0}|${y1 - y0}`;
      if (place !== placed) {
        placed = place;
        Object.assign(canvas.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
      }
      const cw = Math.round((x1 - x0) * ratio), ch = Math.round((y1 - y0) * ratio);
      if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
      ctx.setTransform(ratio, 0, 0, ratio, -x0 * ratio, -y0 * ratio);
      ctx.globalAlpha = 1;
      ctx.fillStyle = background;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      paintSky(ctx, w, h, dark);

      // Bintang di balik kaca diam pada kecerahan rata-rata kelipnya: kelip
      // akan memaksa kaca digambar ulang tiap frame, dan tak terlihat lewat pembiasan.
      ctx.fillStyle = `rgb(${star})`;
      for (const s of STARS) {
        const sx = (s.x / 100) * w, sy = (s.y / 100) * h;
        if (sx < x0 - 2 || sx > x1 + 2 || sy < y0 - 2 || sy > y1 + 2) continue;
        ctx.globalAlpha = s.dim * 0.68;
        ctx.beginPath();
        ctx.arc(sx, sy, s.size * 0.46, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (word) paintWordmark(ctx, word);
      layers.forEach((layer) => { ctx.save(); layer.paint(ctx, ratio, area); ctx.restore(); });
      // Versi baru -> GlassSurface mengunggah tekstur dan menggambar kaca ulang.
      canvas.dataset.frame = String(++version);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [canvasRef]);

  return <canvas ref={canvasRef} className="intro-backdrop" aria-hidden="true" />;
}

/** Sama dengan latar `.intro-sky`: radial-gradient(ellipse 70% 38%/34% at 50% 104%, biru, transparent 70%). */
function paintSky(ctx: CanvasRenderingContext2D, w: number, h: number, dark: boolean) {
  const [rgb, alpha, ry] = dark ? ['0, 120, 255', 0.34, 0.38] : ['0, 145, 255', 0.16, 0.34];
  ctx.save();
  ctx.translate(w / 2, h * 1.04);
  ctx.scale(w * 0.7, h * ry);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, `rgba(${rgb}, ${alpha})`);
  g.addColorStop(0.7, `rgba(${rgb}, 0)`);
  ctx.fillStyle = g;
  ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
}

/** Keadaan wordmark "gammā" saat ini (posisi, skala, opacity, blur animasinya), bila masuk area. */
function wordmarkState(stage: HTMLElement, origin: DOMRect, area: BackdropArea) {
  const el = stage.querySelector<HTMLElement>('.intro-wordmark-text');
  if (!el || !el.offsetWidth) return undefined;
  const box = el.getBoundingClientRect();
  const left = box.left - origin.left, top = box.top - origin.top;
  if (left > area.x1 || top > area.y1 || left + box.width < area.x0 || top + box.height < area.y0) return undefined;
  const cs = getComputedStyle(el);
  const opacity = parseFloat(cs.opacity);
  if (!(opacity > 0)) return undefined;
  return {
    el, cs, opacity, cx: left + box.width / 2, cy: top + box.height / 2, scale: box.width / el.offsetWidth,
    key: `${left.toFixed(1)},${top.toFixed(1)},${box.width.toFixed(1)},${opacity.toFixed(3)},${cs.filter},${cs.color}`,
  };
}

function paintWordmark(ctx: CanvasRenderingContext2D, word: NonNullable<ReturnType<typeof wordmarkState>>) {
  const { el, cs } = word;
  ctx.save();
  ctx.translate(word.cx, word.cy);
  ctx.scale(word.scale, word.scale);
  ctx.globalAlpha = word.opacity;
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = cs.letterSpacing;
  if ('filter' in ctx && cs.filter !== 'none') ctx.filter = cs.filter;
  ctx.fillStyle = cs.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const text = el.textContent ?? '';
  const m = ctx.measureText(text);
  const ascent = m.fontBoundingBoxAscent || parseFloat(cs.fontSize) * 0.8;
  const descent = m.fontBoundingBoxDescent || parseFloat(cs.fontSize) * 0.2;
  const lineHeight = el.offsetHeight;
  ctx.fillText(text, 0, -lineHeight / 2 + (lineHeight - (ascent + descent)) / 2 + ascent);
  ctx.restore();
}
