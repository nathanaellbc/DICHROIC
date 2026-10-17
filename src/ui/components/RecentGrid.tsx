/**
 * Welcome back: semua proyek sebagai grid bento (masonry) -- tinggi tiap
 * ubin mengikuti rasio fotonya, sudut kontinu Apple. Judul di tengah atas
 * ("Welcome back" / gammā, tanpa tombol kembali), tombol "New photo" kaca
 * buram melayang di bawah. Ketuk ubin = buka (foto terbang ke editor), tekan
 * lama / klik kanan = menu proyek (Rename, Duplicate, Delete).
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProjectCard } from '../projects/projects';
import { recipeParts, relativeTime } from '../projects/format';
import { haptic } from '../haptics';
import { Icon } from './Icon';
import { launchOpen, isClosingFlight, useClosingProject } from './PhotoFlight';

/** Lebar kolom minimum (px) dan jarak antar ubin. */
const MIN_COLUMN = 168;
const GAP = 8;
const HOLD_MS = 480;
const HOLD_SLOP = 10;
/** Rasio ubin dijepit supaya panorama/potret ekstrem tetap enak dilihat. */
const clampAspect = (r: number) => Math.min(1.8, Math.max(0.56, r));

export function RecentGrid({ cards, onOpen, onRelink, onMenu, onNew, onSettings, hint }: {
  cards: readonly ProjectCard[];
  onOpen: (card: ProjectCard) => void;
  onRelink: (card: ProjectCard) => void;
  onMenu: (card: ProjectCard, anchor: DOMRect) => void;
  onNew: () => void;
  onSettings: () => void;
  hint?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const reduce = useReducedMotion();
  const closing = useClosingProject();
  // Tanpa animasi masuk saat foto sedang terbang kembali ke ubinnya.
  const [enter] = useState(() => !isClosingFlight() && !reduce);
  const hold = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  /** Pesan "Camera is coming soon" di atas dock, hilang sendiri. */
  const [soon, setSoon] = useState(false);
  useEffect(() => {
    if (!soon) return undefined;
    const t = window.setTimeout(() => setSoon(false), 1800);
    return () => window.clearTimeout(t);
  }, [soon]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Masonry: tiap ubin ke kolom terpendek (urutan terbaru tetap terbaca kiri-ke-kanan, atas-ke-bawah).
  const inner = Math.min(width, 980) - 2 * 12;
  const count = Math.max(2, Math.min(5, Math.floor((inner + GAP) / (MIN_COLUMN + GAP))));
  const columns: Array<{ card: ProjectCard; index: number }[]> = Array.from({ length: count }, () => []);
  const heights = new Array<number>(count).fill(0);
  cards.forEach((card, index) => {
    const ratio = clampAspect(card.width > 0 && card.height > 0 ? card.width / card.height : 1);
    let col = 0;
    for (let i = 1; i < count; i++) if (heights[i]! < heights[col]! - 1e-6) col = i;
    columns[col]!.push({ card, index });
    heights[col] = heights[col]! + 1 / ratio;
  });

  const cancelHold = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
  };
  const open = (card: ProjectCard, el: HTMLElement) => {
    if (card.missing) { onRelink(card); return; }
    launchOpen(card.id, card.thumb, el, card.width / Math.max(1, card.height));
    onOpen(card);
  };

  return (
    <div className="bento-screen">
      <div ref={scroller} className="bento-scroll">
        <header className="bento-header">
          <h1>Welcome back</h1>
          <span>gammā{hint ? ` · ${hint}` : ''}</span>
        </header>
        <div className="bento-grid" role="list" aria-label="Your projects" style={{ ['--cols' as string]: count }}>
          {columns.map((column, c) => (
            <div key={c} className="bento-column">
              {column.map(({ card, index }) => {
                const { film } = recipeParts(card.params);
                const ratio = clampAspect(card.width > 0 && card.height > 0 ? card.width / card.height : 1);
                return (
                  <motion.button
                    key={card.id}
                    id={`recent-${card.id}`}
                    type="button"
                    role="listitem"
                    className="bento-tile"
                    data-missing={card.missing || undefined}
                    data-flying={closing === card.id || undefined}
                    aria-label={`${card.name}, ${card.missing ? 'original photo missing' : film}, ${relativeTime(card.updatedAt)}`}
                    style={{ aspectRatio: ratio }}
                    initial={enter ? { opacity: 0, y: 14, scale: 0.97 } : false}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ type: 'spring', duration: 0.55, bounce: 0.12, delay: enter ? Math.min(index, 10) * 0.035 : 0 }}
                    whileTap={{ scale: 0.97 }}
                    onPointerDown={(e) => {
                      if (e.pointerType === 'mouse') return;
                      cancelHold();
                      const el = e.currentTarget;
                      hold.current = { x: e.clientX, y: e.clientY, fired: false, timer: window.setTimeout(() => {
                        if (!hold.current) return;
                        hold.current.fired = true;
                        haptic();
                        onMenu(card, el.getBoundingClientRect());
                      }, HOLD_MS) };
                    }}
                    onPointerMove={(e) => {
                      const h = hold.current;
                      if (h && !h.fired && Math.hypot(e.clientX - h.x, e.clientY - h.y) > HOLD_SLOP) cancelHold();
                    }}
                    onPointerUp={cancelHold}
                    onPointerCancel={cancelHold}
                    onClick={(e) => {
                      if (hold.current?.fired) { hold.current = null; return; }
                      hold.current = null;
                      open(card, e.currentTarget);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      cancelHold();
                      onMenu(card, e.currentTarget.getBoundingClientRect());
                    }}
                  >
                    {card.thumb && !card.missing && (
                      <img
                        className="bento-photo"
                        src={card.thumb}
                        alt=""
                        draggable={false}
                        decoding="async"
                        onLoad={(e) => { e.currentTarget.dataset.loaded = ''; }}
                        ref={(el) => { if (el?.complete && el.naturalWidth > 0) el.dataset.loaded = ''; }}
                      />
                    )}
                    {card.missing && <span className="bento-missing"><Icon name="warning" size={22} /><span>Choose the photo again</span></span>}
                    <span className="bento-label">
                      <b>{card.name}</b>
                      <span>{card.missing ? 'Missing original' : film}</span>
                    </span>
                  </motion.button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {/* Dock: kamera (segera), + foto baru (kaca biru), Settings. */}
      <div className="bento-dock">
        <AnimatePresence>
          {soon && (
            <motion.span
              key="soon"
              className="dock-soon"
              role="status"
              initial={{ opacity: 0, y: 8, scale: 0.92 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.96 }}
              transition={{ type: 'spring', duration: 0.35, bounce: 0.15 }}
            >
              <Icon name="camera" size={15} /> Camera is coming soon
            </motion.span>
          )}
        </AnimatePresence>
        <div className="dock-bar">
          <motion.button type="button" className="dock-side" aria-label="Camera" whileTap={{ scale: 0.9 }} onClick={() => { haptic(); setSoon(true); }}>
            <Icon name="camera" size={21} />
          </motion.button>
          <motion.button type="button" className="dock-plus" aria-label="New photo" whileTap={{ scale: 0.9 }} onClick={() => { haptic(); onNew(); }}>
            <Icon name="plus" size={26} strokeWidth={2.4} />
          </motion.button>
          <motion.button type="button" className="dock-side" aria-label="Settings" whileTap={{ scale: 0.9 }} onClick={() => { haptic(); onSettings(); }}>
            <Icon name="settings" size={21} />
          </motion.button>
        </div>
      </div>
    </div>
  );
}
