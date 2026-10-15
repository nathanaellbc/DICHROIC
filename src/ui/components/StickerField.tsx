/**
 * Stiker layar mulai: menyembur dari gelembung ke atas membentuk V (seperti
 * gunung meletus) lalu melayang di sekitar titik mendaratnya -- memantul di tepi layar, saling bertabrakan, memantul dari
 * gelembung, dan bisa dipegang lalu dilempar. Satu loop rAF menulis transform
 * langsung ke DOM (tanpa render React per frame).
 */
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import type { UiIconName } from './Icon';
import type { StageBox } from './WelcomeIntro';
import HoloCard from './reactbits/HoloCard';
import { addBackdropLayer } from './IntroBackdrop';
import type { HoloPreset } from './reactbits/HoloCard';

type Sticker =
  | { kind: 'stock'; label: string; sub: string; tone: string }
  | { kind: 'icon'; icon: UiIconName }
  | { kind: 'quote'; text: string }
  | { kind: 'frame'; hue: number };

/**
 * Isi aplikasi: nama stok film (warna kotak filmnya -- isi, bukan aksen UI),
 * ikon kamar gelap, potongan bingkai film, dan kutipan pendek. Posisinya
 * dari letusan berbentuk V di atas gelembung (`veeCone`); r = rotasi;
 * small = disembunyikan di layar sempit.
 */
const STICKERS: ReadonlyArray<{ s: Sticker; r: number; small?: boolean }> = [
  { s: { kind: 'stock', label: 'Portra 400', sub: 'Kodak', tone: '#e8b04a' }, r: -8 },
  { s: { kind: 'stock', label: 'Velvia 50', sub: 'Fujifilm', tone: '#2f9e5b' }, r: 8 },
  { s: { kind: 'icon', icon: 'aperture' }, r: -12, small: true },
  { s: { kind: 'icon', icon: 'print' }, r: 12, small: true },
  { s: { kind: 'stock', label: 'Vision3 500T', sub: 'Kodak', tone: '#d1452f' }, r: -3 },
  { s: { kind: 'frame', hue: 28 }, r: 7 },
  { s: { kind: 'quote', text: 'Shot on real film' }, r: -6 },
  { s: { kind: 'icon', icon: 'grain' }, r: -10 },
  { s: { kind: 'icon', icon: 'halation' }, r: 10 },
  { s: { kind: 'quote', text: 'Printed on 2383' }, r: -5, small: true },
  { s: { kind: 'stock', label: 'CineStill 800T', sub: 'CineStill', tone: '#3d5fc4' }, r: 5, small: true },
  { s: { kind: 'stock', label: 'Ektar 100', sub: 'Kodak', tone: '#c2328a' }, r: 6 },
  { s: { kind: 'stock', label: 'Tri-X 400', sub: 'Kodak', tone: '#2a2a2e' }, r: -6 },
  { s: { kind: 'icon', icon: 'camera' }, r: 9 },
  { s: { kind: 'frame', hue: 205 }, r: -9 },
  { s: { kind: 'icon', icon: 'lens' }, r: -8, small: true },
  { s: { kind: 'icon', icon: 'flash' }, r: 8, small: true },
  { s: { kind: 'stock', label: 'HP5 Plus', sub: 'Ilford', tone: '#55555c' }, r: 5 },
  { s: { kind: 'stock', label: 'Gold 200', sub: 'Kodak', tone: '#e0902c' }, r: -5 },
  { s: { kind: 'quote', text: 'Grain, not noise' }, r: -3, small: true },
  { s: { kind: 'frame', hue: 330 }, r: 4, small: true },
];

/** Pola foil HoloCard bergiliran per stiker. */
const HOLO_PRESETS: readonly HoloPreset[] = ['bursts', 'stars', 'cosmos', 'shards', 'glitter', 'rainbow'];

function StickerFace({ s, index }: { s: Sticker; index: number }): ReactNode {
  switch (s.kind) {
    case 'stock':
    case 'frame': {
      // Kotak film dan bingkai: kartu foil holografik (HoloCard, React Bits).
      const art = stickerArt(s);
      if (!art) break;
      return (
        <HoloCard
          image={art.src}
          alt=""
          width={art.width}
          radius={art.radius}
          preset={s.kind === 'frame' ? 'rainbow' : HOLO_PRESETS[index % HOLO_PRESETS.length]!}
          intensity={0.6}
          scale={1.6}
          frame={art.frame}
          edgeSparkle={0.9}
          glare={0.45}
          tiltMax={18}
          hoverScale={1.06}
          shadow={false}
          className="sticker-holo"
          // Rasio diketahui sejak awal (bukan rasio kartu bawaan sebelum gambar dimuat),
          // supaya ukuran tabrakan stiker benar.
          style={{ ['--hc-ratio' as string]: art.width / art.height }}
        />
      );
    }
    case 'icon':
      return <span className="sticker sticker-icon"><Icon name={s.icon} size={20} strokeWidth={2} /></span>;
    case 'quote':
      return <span className="sticker sticker-quote">{s.text}</span>;
  }
  // Tanpa kanvas 2D: stiker CSS biasa.
  return s.kind === 'stock'
    ? <span className="sticker sticker-stock" style={{ ['--tone' as string]: s.tone }}><b>{s.label}</b><small>{s.sub}</small></span>
    : s.kind === 'frame' ? <span className="sticker sticker-frame" style={{ ['--hue' as string]: (s as { hue: number }).hue }} /> : null;
}

const ART_SCALE = 3;
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter Variable", system-ui, sans-serif';
const artCache = new Map<string, { src: string; width: number; height: number; radius: number; frame: number }>();

/**
 * Gambar muka stiker untuk HoloCard (tekstur WebGL): kotak film berwarna
 * dengan nama stok, atau bingkai foto bergradien, berpinggiran putih seperti
 * stiker CSS sebelumnya. Digambar sekali per stiker (resolusi 3x) lalu
 * di-cache sebagai data URL (satu origin, aman untuk tekstur).
 */
function stickerArt(s: Extract<Sticker, { kind: 'stock' | 'frame' }>) {
  const key = s.kind === 'stock' ? `stock|${s.label}|${s.sub}|${s.tone}` : `frame|${s.hue}`;
  const cached = artCache.get(key);
  if (cached) return cached;
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : undefined;
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return undefined;
  const k = ART_SCALE;
  const round = (x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient) => {
    ctx.beginPath();
    ctx.roundRect(x * k, y * k, w * k, h * k, r * k);
    ctx.fillStyle = fill;
    ctx.fill();
  };
  let w: number, h: number, radius: number;
  if (s.kind === 'stock') {
    ctx.font = `700 ${14 * k}px ${FONT}`;
    const label = ctx.measureText(s.label).width / k;
    ctx.font = `600 ${10 * k}px ${FONT}`;
    const sub = ctx.measureText(s.sub.toUpperCase()).width / k + s.sub.length * 0.6;
    w = Math.ceil(Math.max(label, sub) + 30); h = 44; radius = 12;
    canvas.width = w * k; canvas.height = h * k;
    round(0, 0, w, h, radius, '#ffffff');
    round(3, 3, w - 6, h - 6, radius - 3, s.tone);
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = `700 ${14 * k}px ${FONT}`;
    ctx.fillText(s.label, (w / 2) * k, 21 * k);
    ctx.globalAlpha = 0.85;
    ctx.font = `600 ${10 * k}px ${FONT}`;
    if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${0.6 * k}px`;
    ctx.fillText(s.sub.toUpperCase(), (w / 2) * k, 34 * k);
    ctx.globalAlpha = 1;
  } else {
    w = 62; h = 48; radius = 7;
    canvas.width = w * k; canvas.height = h * k;
    round(0, 0, w, h, radius, '#ffffff');
    round(2, 2, w - 4, h - 4, radius - 1, '#111111');
    const g = ctx.createLinearGradient(6 * k, 6 * k, (w - 6) * k, (h - 6) * k);
    g.addColorStop(0, `hsl(${s.hue} 70% 70%)`);
    g.addColorStop(1, `hsl(${s.hue + 40} 55% 38%)`);
    round(6, 6, w - 12, h - 12, 3, g);
  }
  // Pinggiran berkilau HoloCard (persen lebar) = pinggiran putih 3 px.
  const art = { src: canvas.toDataURL('image/png'), width: w, height: h, radius, frame: (3 / w) * 100 };
  artCache.set(key, art);
  return art;
}

const imageCache = new Map<string, HTMLImageElement>();
/** Bertambah tiap gambar selesai dimuat: bagian kunci lapisan, supaya kanvas digambar ulang. */
let imagesLoaded = 0;
function cachedImage(src: string) {
  let image = imageCache.get(src);
  if (!image) {
    image = new Image();
    image.onload = () => { imagesLoaded++; };
    image.src = src;
    imageCache.set(src, image);
  }
  return image.complete && image.naturalWidth ? image : undefined;
}

/** Ikon SVG stiker sebagai gambar (warna isi ikon); disusun sekali per elemen. */
const iconSources = new WeakMap<HTMLElement, { src: string; size: number }>();
function iconImage(face: HTMLElement) {
  let icon = iconSources.get(face);
  if (!icon) {
    const svg = face.querySelector('svg');
    if (!svg) return undefined;
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('color', getComputedStyle(face).color);
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
    icon = { src, size: parseFloat(svg.getAttribute('width') ?? '') || 20 };
    iconSources.set(face, icon);
  }
  return { image: cachedImage(icon.src), size: icon.size };
}

/**
 * Muka stiker di kanvas latar, berpusat di (0, 0) dengan ukuran CSS-nya:
 * gambar foil (tanpa efek holo), ikon, atau gelembung kutipan, beserta bayangannya.
 * `ratio` = px kanvas per px CSS stiker (bayangan kanvas tidak ikut transform).
 */
function paintSticker(ctx: CanvasRenderingContext2D, s: Sticker, face: HTMLElement, ratio: number) {
  const w = face.offsetWidth, h = face.offsetHeight;
  const shadow = (blur: number, y: number, alpha: number) => {
    ctx.shadowColor = `rgba(0, 0, 0, ${alpha})`;
    ctx.shadowBlur = blur * ratio;
    ctx.shadowOffsetY = y * ratio;
  };
  if (s.kind === 'stock' || s.kind === 'frame') {
    const art = stickerArt(s), image = art && cachedImage(art.src);
    if (!image) return;
    shadow(12, 6, 0.28);
    ctx.drawImage(image, -w / 2, -h / 2, w, h);
    return;
  }
  shadow(18, 6, 0.35);
  if (s.kind === 'icon') {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(0, 0, w / 2, 0, Math.PI * 2); ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.fillStyle = '#f5f5f7';
    ctx.beginPath(); ctx.arc(0, 0, w / 2 - 2, 0, Math.PI * 2); ctx.fill();
    const icon = iconImage(face);
    if (icon?.image) ctx.drawImage(icon.image, -icon.size / 2, -icon.size / 2, icon.size, icon.size);
    return;
  }
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, [16, 16, 16, 4]); ctx.fill();
  ctx.shadowColor = 'transparent';
  const cs = getComputedStyle(face);
  ctx.fillStyle = cs.color;
  ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(s.text, 0, 0.5);
}

/** Satu stiker dalam simulasi (px panggung, kecepatan px/s, rotasi derajat). */
interface Body {
  x: number; y: number; vx: number; vy: number; r: number; vr: number;
  tx: number; ty: number; tr: number; rest: number; scale: number;
  w: number; h: number; born: number; free: boolean;
  /** Baru dilempar: titik mendarat pindah ke tempat ia berhenti. */
  rehome?: boolean;
  /** Pernah dilempar pengguna: boleh berada di bawah gelembung. */
  thrown?: boolean;
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
    const { origin: O0, orbRadius: R0, box: B0 } = live.current;
    // Letusan: tiap stiker punya arah di dalam kerucut V di atas gelembung.
    const cone = veeCone(items.length, O0, R0, B0);
    bodies.current = items.map((item, i) => {
      const face = els.current[i]?.firstElementChild as HTMLElement | null | undefined;
      const rest = (item.small ? 0.86 : 1) * (compact ? 0.9 : 1);
      const w = (face?.offsetWidth ?? 60) * rest, h = (face?.offsetHeight ?? 40) * rest;
      const { tx, ty, dx, dy } = cone[i]!;
      const base = { tx, ty, tr: item.r, rest, w, h, vr: 0 };
      // Dilontarkan keluar dari kawah dengan kecepatan awal searah kerucut.
      const kick = 900 + (i % 3) * 160;
      return reduce
        ? { ...base, x: tx, y: ty, vx: 0, vy: 0, r: item.r, scale: rest, born: start - 1e4, free: true }
        : { ...base, x: O0.x, y: O0.y, vx: dx * kick, vy: dy * kick, r: 0, scale: 0.2, born: start + i * 45, free: false };
    });

    const paint = (t: number) => {
      bodies.current.forEach((b, i) => {
        const el = els.current[i];
        if (!el) return;
        el.style.transform = `translate(${b.x}px, ${b.y}px) translate(-50%, -50%) rotate(${b.r}deg) scale(${b.scale})`;
        el.style.opacity = String(Math.max(0, Math.min(1, (t - b.born) / 160)));
      });
    };
    // Salinan stiker di kanvas latar kaca (dilihat lewat kaca WebGL): hanya
    // stiker yang menyentuh area kaca, dengan transform dan opacity saat ini.
    let shown: { b: Body; face: HTMLElement; s: Sticker; alpha: number }[] = [];
    const unpaint = addBackdropLayer({
      key: (area) => {
        const now = performance.now();
        const layer = els.current[0]?.parentElement;
        const fade = layer ? parseFloat(layer.style.opacity || '1') : 1;
        shown = [];
        bodies.current.forEach((b, i) => {
          const face = els.current[i]?.firstElementChild as HTMLElement | null | undefined;
          const item = items[i];
          if (!face || !item || now < b.born) return;
          const alpha = Math.max(0, Math.min(1, (now - b.born) / 160)) * fade;
          // Jangkauan: setengah diagonal + bayangan.
          const reach = (Math.hypot(face.offsetWidth, face.offsetHeight) / 2) * b.scale + 24;
          if (!(alpha > 0) || b.x + reach < area.x0 || b.x - reach > area.x1 || b.y + reach < area.y0 || b.y - reach > area.y1) return;
          shown.push({ b, face, s: item.s, alpha });
        });
        return `${imagesLoaded}:` + shown.map(({ b, alpha }) => `${b.x.toFixed(1)},${b.y.toFixed(1)},${b.r.toFixed(1)},${b.scale.toFixed(3)},${alpha.toFixed(2)}`).join(';');
      },
      paint: (ctx, ratio) => {
        shown.forEach(({ b, face, s: sticker, alpha }) => {
          ctx.save();
          ctx.translate(b.x, b.y);
          ctx.rotate((b.r * Math.PI) / 180);
          ctx.scale(b.scale, b.scale);
          ctx.globalAlpha = alpha;
          paintSticker(ctx, sticker, face, ratio * b.scale);
          ctx.restore();
        });
      },
    });
    if (reduce) { paint(start); return unpaint; }

    // Arah melayang = arah letusannya (tetap di dalam kerucut V).
    const drift = cone.map((c) => ({ x: c.dx, y: c.dy }));
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
          // Melayang di sekitar titik mendaratnya (bentuk V tetap terbaca):
          // kecepatan pelan-pelan menuju "kembali ke titik + goyangan kecil",
          // jadi lemparan keras melambat. Stiker yang dilempar pindah rumah ke
          // tempat ia berhenti.
          const sp = Math.hypot(b.vx, b.vy);
          if (b.rehome && sp < 40) { b.tx = b.x; b.ty = b.y; b.rehome = false; }
          const phase = (t / 1000) * 0.55 + i * 1.7;
          const wantX = b.rehome ? 0 : (b.tx - b.x) * 1.4 + Math.cos(phase) * cruise + drift[i]!.x * cruise * 0.4;
          const wantY = b.rehome ? 0 : (b.ty - b.y) * 1.4 + Math.sin(phase * 0.8) * cruise + drift[i]!.y * cruise * 0.4;
          const relax = 1 - Math.exp(-dt / (b.rehome ? 0.9 : 0.7));
          b.vx += (wantX - b.vx) * relax;
          b.vy += (wantY - b.vy) * relax;
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
          spread(a, b, SPREAD * (compact ? 0.6 : 0.85), dt);
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

      // Letusan tetap di atas: lantai lunak setinggi gelembung (kecuali yang dilempar).
      list.forEach((b) => {
        if (!b.free || b.held || b.thrown) return;
        const floor = O.y - R * 0.6;
        if (b.y > floor) { b.vy -= (b.y - floor) * 30 * dt; if (b.vy > 0) b.vy *= 0.85; }
      });

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
    return () => { cancelAnimationFrame(raf); unpaint(); };
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
    b.rehome = true;
    b.thrown = true;
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
          <StickerFace s={item.s} index={i} />
        </div>
      ))}
    </>
  );
}

/**
 * Titik mendarat letusan: kerucut V terbuka ke atas dari gelembung (seperti
 * gunung meletus). Sudut dalam +-36 derajat dari vertikal, jarak dari tepi
 * gelembung sampai dekat tepi atas panggung; urutan sudut emas supaya
 * tersebar rata tanpa acak. dx, dy = arah satuan dari pusat gelembung.
 */
function veeCone(n: number, O: { x: number; y: number }, R: number, B: StageBox) {
  const half = (36 * Math.PI) / 180;
  const near = R + 64, far = Math.max(near + 40, O.y - 40);
  return Array.from({ length: n }, (_, i) => {
    const u = ((i * 0.618034) % 1) * 2 - 1;
    const a = -Math.PI / 2 + u * half;
    const dx = Math.cos(a), dy = Math.sin(a);
    // Jarak tersebar rata sepanjang kerucut, tidak melewati batas atas.
    const reach = near + (far - near) * ((i * 0.381966 + 0.1) % 1);
    const d = Math.min(reach, far / Math.max(0.35, -dy));
    const tx = Math.max(24, Math.min(B.width - 24, O.x + dx * d));
    return { tx, ty: O.y + dy * d, dx, dy };
  });
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
