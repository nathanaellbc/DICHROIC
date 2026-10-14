/**
 * Stiker layar mulai: menyembur dari gelembung lalu melayang bebas di seluruh
 * layar -- memantul di tepi layar, saling bertabrakan, memantul dari
 * gelembung, dan bisa dipegang lalu dilempar. Satu loop rAF menulis transform
 * langsung ke DOM (tanpa render React per frame).
 */
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import type { UiIconName } from './Icon';
import type { StageBox } from './WelcomeIntro';

type Sticker =
  | { kind: 'stock'; label: string; sub: string; tone: string }
  | { kind: 'icon'; icon: UiIconName }
  | { kind: 'quote'; text: string }
  | { kind: 'frame'; hue: number };

/**
 * Isi aplikasi: nama stok film (warna kotak filmnya -- isi, bukan aksen UI),
 * ikon kamar gelap, potongan bingkai film, dan kutipan pendek. Posisi awal
 * dalam pecahan panggung (fx, fy 0..1), berpasangan cermin kiri-kanan supaya
 * sebarannya seimbang; r = rotasi; small = disembunyikan di layar sempit.
 */
const STICKERS: ReadonlyArray<{ s: Sticker; fx: number; fy: number; r: number; small?: boolean }> = [
  { s: { kind: 'stock', label: 'Portra 400', sub: 'Kodak', tone: '#e8b04a' }, fx: 0.16, fy: 0.1, r: -8 },
  { s: { kind: 'stock', label: 'Velvia 50', sub: 'Fujifilm', tone: '#2f9e5b' }, fx: 0.84, fy: 0.1, r: 8 },
  { s: { kind: 'icon', icon: 'aperture' }, fx: 0.4, fy: 0.06, r: -12, small: true },
  { s: { kind: 'icon', icon: 'print' }, fx: 0.6, fy: 0.06, r: 12, small: true },
  { s: { kind: 'stock', label: 'Vision3 500T', sub: 'Kodak', tone: '#d1452f' }, fx: 0.5, fy: 0.18, r: -3 },
  { s: { kind: 'frame', hue: 28 }, fx: 0.25, fy: 0.25, r: 7 },
  { s: { kind: 'quote', text: 'Shot on real film' }, fx: 0.75, fy: 0.25, r: -6 },
  { s: { kind: 'icon', icon: 'grain' }, fx: 0.08, fy: 0.36, r: -10 },
  { s: { kind: 'icon', icon: 'halation' }, fx: 0.92, fy: 0.36, r: 10 },
  { s: { kind: 'quote', text: 'Printed on 2383' }, fx: 0.3, fy: 0.37, r: -5, small: true },
  { s: { kind: 'stock', label: 'CineStill 800T', sub: 'CineStill', tone: '#3d5fc4' }, fx: 0.7, fy: 0.37, r: 5, small: true },
  { s: { kind: 'stock', label: 'Ektar 100', sub: 'Kodak', tone: '#c2328a' }, fx: 0.17, fy: 0.5, r: 6 },
  { s: { kind: 'stock', label: 'Tri-X 400', sub: 'Kodak', tone: '#2a2a2e' }, fx: 0.83, fy: 0.5, r: -6 },
  { s: { kind: 'icon', icon: 'camera' }, fx: 0.07, fy: 0.66, r: 9 },
  { s: { kind: 'frame', hue: 205 }, fx: 0.93, fy: 0.66, r: -9 },
  { s: { kind: 'icon', icon: 'lens' }, fx: 0.1, fy: 0.8, r: -8, small: true },
  { s: { kind: 'icon', icon: 'flash' }, fx: 0.9, fy: 0.8, r: 8, small: true },
  { s: { kind: 'stock', label: 'HP5 Plus', sub: 'Ilford', tone: '#55555c' }, fx: 0.13, fy: 0.93, r: 5 },
  { s: { kind: 'stock', label: 'Gold 200', sub: 'Kodak', tone: '#e0902c' }, fx: 0.87, fy: 0.93, r: -5 },
  { s: { kind: 'quote', text: 'Grain, not noise' }, fx: 0.33, fy: 0.97, r: -3, small: true },
  { s: { kind: 'frame', hue: 330 }, fx: 0.67, fy: 0.97, r: 4, small: true },
];

function StickerFace({ s }: { s: Sticker }): ReactNode {
  switch (s.kind) {
    case 'stock':
      return <span className="sticker sticker-stock" style={{ ['--tone' as string]: s.tone }}><b>{s.label}</b><small>{s.sub}</small></span>;
    case 'icon':
      return <span className="sticker sticker-icon"><Icon name={s.icon} size={20} strokeWidth={2} /></span>;
    case 'quote':
      return <span className="sticker sticker-quote">{s.text}</span>;
    case 'frame':
      return <span className="sticker sticker-frame" style={{ ['--hue' as string]: s.hue }} />;
  }
}

/** Satu stiker dalam simulasi (px panggung, kecepatan px/s, rotasi derajat). */
interface Body {
  x: number; y: number; vx: number; vy: number; r: number; vr: number;
  tx: number; ty: number; tr: number; rest: number; scale: number;
  w: number; h: number; born: number; free: boolean;
  held?: { id: number; ox: number; oy: number; lx: number; ly: number; lt: number };
}

const WALL = 6;
const BOUNCE = 0.82;
const THROW_MAX = 2400;
/** Jarak tolakan lembut antar stiker (px). */
const SPREAD = 150;

export function StickerBurst({ show, origin, orbRadius, box, compact, reduce }: {
  show: boolean; origin: { x: number; y: number }; orbRadius: number; box: StageBox; compact: boolean; reduce: boolean;
}) {
  return (
    <AnimatePresence>
      {show && box.width > 0 && (
        <motion.div
          key="stickers"
          className="intro-stickers"
          aria-hidden="true"
          exit={{ opacity: 0, transition: { duration: 0.2 } }}
        >
          <StickerField origin={origin} orbRadius={orbRadius} box={box} compact={compact} reduce={reduce} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function StickerField({ origin, orbRadius, box, compact, reduce }: {
  origin: { x: number; y: number }; orbRadius: number; box: StageBox; compact: boolean; reduce: boolean;
}) {
  const items = compact ? STICKERS.filter((item) => !item.small) : STICKERS;
  const els = useRef<(HTMLDivElement | null)[]>([]);
  const bodies = useRef<Body[]>([]);
  // Nilai terbaru untuk loop tanpa memulai ulang simulasi.
  const live = useRef({ origin, orbRadius, box });
  live.current = { origin, orbRadius, box };

  useEffect(() => {
    const start = performance.now();
    const { origin: O0, box: B0 } = live.current;
    bodies.current = items.map((item, i) => {
      const face = els.current[i]?.firstElementChild as HTMLElement | null | undefined;
      const rest = (item.small ? 0.86 : 1) * (compact ? 0.9 : 1);
      const w = (face?.offsetWidth ?? 60) * rest, h = (face?.offsetHeight ?? 40) * rest;
      const tx = item.fx * B0.width, ty = item.fy * B0.height;
      const base = { tx, ty, tr: item.r, rest, w, h, vx: 0, vy: 0, vr: 0 };
      return reduce
        ? { ...base, x: tx, y: ty, r: item.r, scale: rest, born: start - 1e4, free: true }
        : { ...base, x: O0.x, y: O0.y, r: 0, scale: 0.2, born: start + i * 35, free: false };
    });

    const paint = (t: number) => {
      bodies.current.forEach((b, i) => {
        const el = els.current[i];
        if (!el) return;
        el.style.transform = `translate(${b.x}px, ${b.y}px) translate(-50%, -50%) rotate(${b.r}deg) scale(${b.scale})`;
        el.style.opacity = String(Math.max(0, Math.min(1, (t - b.born) / 160)));
      });
    };
    if (reduce) { paint(start); return undefined; }

    // Arah melayang tetap per stiker (sudut emas: tersebar rata, tanpa acak).
    const drift = items.map((_, i) => ({ x: Math.cos(i * 2.39996), y: Math.sin(i * 2.39996) }));
    const cruise = compact ? 16 : 22;
    let last = start, raf = 0;

    const step = (t: number) => {
      const dt = Math.min(0.033, Math.max(0, (t - last) / 1000));
      last = t;
      const { box: B, origin: O, orbRadius: R } = live.current;
      const list = bodies.current;

      list.forEach((b, i) => {
        if (t < b.born) return;
        // Skala: mendekat ke ukuran istirahat (membesar saat dipegang).
        b.scale += (b.rest * (b.held ? 1.12 : 1) - b.scale) * (1 - Math.exp(-dt * 14));
        if (b.held) return;
        if (!b.free) {
          // Semburan: pegas kurang teredam ke posisi awal -> mendarat memantul.
          const k = 70, c = 2 * Math.sqrt(k) * 0.42;
          b.vx += ((b.tx - b.x) * k - b.vx * c) * dt;
          b.vy += ((b.ty - b.y) * k - b.vy * c) * dt;
          b.r += (b.tr - b.r) * (1 - Math.exp(-dt * 6));
          if (t - b.born > 1200) {
            b.free = true;
            b.vx += drift[i]!.x * cruise; b.vy += drift[i]!.y * cruise;
          }
        } else {
          // Melayang: kecepatan pelan-pelan kembali ke kecepatan jelajah,
          // jadi lemparan keras melambat dan stiker diam mulai bergerak lagi.
          const sp = Math.hypot(b.vx, b.vy);
          const dir = sp < 1 ? drift[i]! : { x: b.vx / sp, y: b.vy / sp };
          const relax = 1 - Math.exp(-dt / 1.1);
          b.vx += (dir.x * cruise - b.vx) * relax;
          b.vy += (dir.y * cruise - b.vy) * relax;
          // Putaran: pegas lembut kembali ke kemiringan asal.
          const dr = ((b.tr - b.r + 540) % 360) - 180;
          b.vr += dr * 5 * dt;
          b.vr -= b.vr * (1 - Math.exp(-dt / 0.5));
          b.r += b.vr * dt;
        }
        b.x += b.vx * dt; b.y += b.vy * dt;
      });

      // Tabrakan antar stiker (lingkaran kira-kira) dan dengan gelembung.
      for (let i = 0; i < list.length; i++) {
        const a = list[i]!;
        if (!a.free) continue;
        const ra = radius(a);
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j]!;
          if (!b.free) continue;
          collide(a, b, ra + radius(b) + 4);
          spread(a, b, SPREAD * (compact ? 0.75 : 1), dt);
        }
        if (a.held) continue;
        const dx = a.x - O.x, dy = a.y - O.y, dist = Math.hypot(dx, dy) || 1e-6, min = R + ra + 6;
        if (dist < min) {
          const nx = dx / dist, ny = dy / dist;
          a.x = O.x + nx * min; a.y = O.y + ny * min;
          const vn = a.vx * nx + a.vy * ny;
          if (vn < 0) { a.vx -= 1.8 * vn * nx; a.vy -= 1.8 * vn * ny; a.vr += (a.vx * ny - a.vy * nx) * 0.05; }
        }
      }

      // Dinding = tepi layar: pantul dengan sedikit kehilangan energi + putaran.
      list.forEach((b) => {
        if (t < b.born) return;
        const rad = (b.r * Math.PI) / 180, c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad)), g = b.scale / b.rest;
        const hw = ((b.w * c + b.h * s) / 2) * g, hh = ((b.w * s + b.h * c) / 2) * g;
        const minX = hw + WALL, maxX = Math.max(minX, B.width - hw - WALL);
        const minY = hh + WALL, maxY = Math.max(minY, B.height - hh - WALL);
        if (b.x < minX) { b.x = minX; if (b.vx < 0 && !b.held) { b.vx = -b.vx * BOUNCE; b.vr += b.vy * 0.06; } }
        if (b.x > maxX) { b.x = maxX; if (b.vx > 0 && !b.held) { b.vx = -b.vx * BOUNCE; b.vr -= b.vy * 0.06; } }
        if (b.y < minY) { b.y = minY; if (b.vy < 0 && !b.held) { b.vy = -b.vy * BOUNCE; b.vr -= b.vx * 0.06; } }
        if (b.y > maxY) { b.y = maxY; if (b.vy > 0 && !b.held) { b.vy = -b.vy * BOUNCE; b.vr += b.vx * 0.06; } }
      });

      paint(t);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // Simulasi dimulai sekali per kemunculan; ukuran/posisi terbaru dibaca dari `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduce, compact]);

  const local = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    const b = bodies.current[i];
    if (!b || reduce || b.held) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* event sintetis */ }
    const p = local(e);
    b.free = true;
    b.held = { id: e.pointerId, ox: p.x - b.x, oy: p.y - b.y, lx: p.x, ly: p.y, lt: performance.now() };
    b.vx = 0; b.vy = 0; b.vr = 0;
    e.currentTarget.dataset.held = '';
  };
  const move = (i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    const b = bodies.current[i], h = b?.held;
    if (!b || !h || h.id !== e.pointerId) return;
    const p = local(e), now = performance.now(), dt = Math.max(4, now - h.lt) / 1000;
    // Kecepatan dihaluskan untuk lemparan saat dilepas.
    b.vx = b.vx * 0.4 + ((p.x - h.lx) / dt) * 0.6;
    b.vy = b.vy * 0.4 + ((p.y - h.ly) / dt) * 0.6;
    b.x = p.x - h.ox; b.y = p.y - h.oy;
    // Miring sedikit mengikuti arah seret.
    b.r += (b.tr + Math.max(-18, Math.min(18, b.vx * 0.012)) - b.r) * 0.25;
    h.lx = p.x; h.ly = p.y; h.lt = now;
  };
  const up = (i: number) => (e: React.PointerEvent<HTMLDivElement>) => {
    const b = bodies.current[i];
    if (!b?.held || b.held.id !== e.pointerId) return;
    // Jari diam sebelum dilepas -> diletakkan, bukan dilempar.
    if (performance.now() - b.held.lt > 80) { b.vx = 0; b.vy = 0; }
    const sp = Math.hypot(b.vx, b.vy);
    if (sp > THROW_MAX) { b.vx *= THROW_MAX / sp; b.vy *= THROW_MAX / sp; }
    b.vr = b.vx * 0.08;
    b.held = undefined;
    delete e.currentTarget.dataset.held;
  };

  return (
    <>
      {items.map((item, i) => (
        <div
          key={i}
          ref={(el) => { els.current[i] = el; }}
          className="intro-sticker"
          style={{ opacity: 0 }}
          onPointerDown={down(i)}
          onPointerMove={move(i)}
          onPointerUp={up(i)}
          onPointerCancel={up(i)}
        >
          <StickerFace s={item.s} />
        </div>
      ))}
    </>
  );
}

/** Jari-jari tabrakan: sisi pendek stiker (stiker panjang boleh sedikit tumpang). */
function radius(b: Body) {
  return Math.min(b.w, b.h) * 0.5 * (b.scale / b.rest);
}

/**
 * Tolakan lembut jarak jauh: stiker saling menjauh pelan supaya tetap
 * tersebar penuh di layar dan tidak bergerombol.
 */
function spread(a: Body, b: Body, range: number, dt: number) {
  const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy);
  if (dist >= range || dist === 0) return;
  const f = ((range - dist) / range) * 60 * dt, nx = dx / dist, ny = dy / dist;
  if (!a.held) { a.vx -= nx * f; a.vy -= ny * f; }
  if (!b.held) { b.vx += nx * f; b.vy += ny * f; }
}

/** Tabrakan elastis dua lingkaran (yang dipegang = massa tak hingga). */
function collide(a: Body, b: Body, min: number) {
  if (a.held && b.held) return;
  const dx = b.x - a.x, dy = b.y - a.y, dist = Math.hypot(dx, dy);
  if (dist >= min || dist === 0) return;
  const nx = dx / dist, ny = dy / dist, overlap = min - dist;
  const wa = a.held ? 0 : b.held ? 1 : 0.5, wb = 1 - wa;
  a.x -= nx * overlap * wa; a.y -= ny * overlap * wa;
  b.x += nx * overlap * wb; b.y += ny * overlap * wb;
  const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rel >= 0) return;
  const j = -1.85 * rel;
  if (!a.held) { a.vx -= j * wa * nx; a.vy -= j * wa * ny; a.vr -= rel * 0.03; }
  if (!b.held) { b.vx += j * wb * nx; b.vy += j * wb * ny; b.vr += rel * 0.03; }
}
