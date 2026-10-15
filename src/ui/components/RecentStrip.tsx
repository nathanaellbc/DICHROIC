/**
 * Recent di layar Start (pola "Image accordion", arah "Light table"): tiap
 * proyek satu bilah; yang tertutup hitam-putih, yang terbuka berwarna dan
 * tetangganya memberi ruang. Arahkan kursor atau geser jari untuk berpindah,
 * ketuk bilah yang terbuka (atau Open) untuk membukanya, panah kiri/kanan
 * dan Enter dari keyboard. Klik kanan atau tekan lama membuka menu proyek.
 * Nama dan resep ada di bawah strip, bukan di atas foto: selalu utuh.
 */
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { ProjectCard } from '../projects/projects';
import { recipeParts, relativeTime } from '../projects/format';
import { haptic } from '../haptics';
import { Icon } from './Icon';

/** Tekan lama untuk menu (ms), dan gerak yang membatalkannya (px). */
const HOLD_MS = 480;
const HOLD_SLOP = 10;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function RecentStrip({ cards, onOpen, onMenu, onRelink }: {
  cards: readonly ProjectCard[];
  onOpen: (card: ProjectCard) => void;
  onMenu: (card: ProjectCard, anchor: DOMRect) => void;
  onRelink: (card: ProjectCard) => void;
}) {
  const [at, setAt] = useState(0);
  const slats = useRef<Array<HTMLDivElement | null>>([]);
  const hold = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  /** The press opened a closed slat: its click must not open the project too. */
  const openedOnPress = useRef(false);
  const index = Math.min(at, cards.length - 1);
  const card = cards[index];

  // Daftar berubah (dibuka, dihapus): yang terbaru di depan terbuka lagi.
  const firstId = cards[0]?.id;
  useEffect(() => setAt(0), [firstId, cards.length]);

  const show = (i: number, feedback: boolean) => {
    if (i < 0 || i >= cards.length || i === index) return;
    setAt(i);
    if (feedback) haptic();
  };

  const under = (x: number) => slats.current.findIndex((el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return x >= r.left - 2 && x <= r.right + 2;
  });

  const cancelHold = () => {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current = null;
  };

  const open = (c: ProjectCard) => (c.missing ? onRelink(c) : onOpen(c));

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const pressed = under(e.clientX);
    openedOnPress.current = pressed >= 0 && pressed !== index;
    show(pressed, e.pointerType === 'touch');
    if (e.pointerType === 'mouse') return;
    cancelHold();
    const target = cards[pressed];
    if (!target) return;
    hold.current = {
      x: e.clientX, y: e.clientY, fired: false,
      timer: window.setTimeout(() => {
        if (!hold.current) return;
        hold.current.fired = true;
        haptic();
        const rect = slats.current[pressed]?.getBoundingClientRect();
        if (rect) onMenu(target, rect);
      }, HOLD_MS),
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const h = hold.current;
    if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > HOLD_SLOP) cancelHold();
    show(under(e.clientX), e.pointerType === 'touch');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { show(index + 1, false); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { show(index - 1, false); e.preventDefault(); }
    else if (e.key === 'Home') { show(0, false); e.preventDefault(); }
    else if (e.key === 'End') { show(cards.length - 1, false); e.preventDefault(); }
    else if ((e.key === 'Enter' || e.key === ' ') && card) { e.preventDefault(); open(card); }
    else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && card) {
      e.preventDefault();
      const rect = slats.current[index]?.getBoundingClientRect();
      if (rect) onMenu(card, rect);
    }
  };

  if (!card) return null;
  const { film, rest } = recipeParts(card.params);
  return (
    <section className="recent" aria-label="Recent projects">
      <div
        className="recent-strip"
        role="listbox"
        aria-label="Recent projects"
        aria-activedescendant={`recent-${card.id}`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={cancelHold}
        onPointerCancel={cancelHold}
        onPointerLeave={cancelHold}
        onKeyDown={onKeyDown}
      >
        {cards.map((c, i) => {
          const isOpen = i === index;
          const parts = recipeParts(c.params);
          return (
            <div
              key={c.id}
              id={`recent-${c.id}`}
              ref={(el) => { slats.current[i] = el; }}
              role="option"
              aria-selected={isOpen}
              aria-label={`${c.name}, ${parts.film} ${parts.rest}, ${relativeTime(c.updatedAt)}${c.missing ? ', original photo missing' : ''}`}
              className="recent-slat"
              data-open={isOpen || undefined}
              data-missing={c.missing || undefined}
              onClick={() => {
                if (hold.current?.fired) { cancelHold(); return; }
                if (openedOnPress.current) { openedOnPress.current = false; return; }
                if (!isOpen) { show(i, false); return; }
                open(c);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                cancelHold();
                show(i, false);
                onMenu(c, e.currentTarget.getBoundingClientRect());
              }}
            >
              {c.thumb && !c.missing && <img className="recent-photo" src={c.thumb} alt="" draggable={false} />}
              {c.missing && <span className="recent-warn" aria-hidden="true"><Icon name="warning" size={22} /></span>}
              <span className="recent-num tabular" aria-hidden="true">{c.missing ? '!' : pad(i + 1)}</span>
            </div>
          );
        })}
      </div>
      <div className="recent-info">
        <div className="recent-text">
          <span className="recent-film" data-missing={card.missing || undefined}>{card.missing ? 'Missing original' : film}</span>
          <strong>{card.name}</strong>
          <span>{card.missing ? 'Choose the photo again to keep editing' : `${rest} · ${relativeTime(card.updatedAt)}`}</span>
        </div>
        <button type="button" className="recent-open" onClick={() => open(card)}>
          {card.missing ? 'Choose Again' : 'Open'}
        </button>
      </div>
      {cards.length > 1 && (
        <div className="recent-dots" aria-hidden="true">
          {cards.map((c, i) => <i key={c.id} data-on={i === index || undefined} />)}
        </div>
      )}
    </section>
  );
}
