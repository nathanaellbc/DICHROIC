/**
 * Recent di layar Start (pola "Image accordion", arah "Light table"): tiap
 * proyek satu bilah; yang tertutup hitam-putih, yang terbuka berwarna dan
 * tetangganya memberi ruang. Arahkan kursor atau geser jari untuk berpindah,
 * ketuk bilah yang terbuka untuk membukanya, panah kiri/kanan
 * dan Enter dari keyboard. Klik kanan atau tekan lama membuka menu proyek.
 * Nama dan resep ada di bawah strip, bukan di atas foto: selalu utuh.
 *
 * Bilah yang terbuka bisa digeser ke atas: fotonya terangkat dan baki aksi
 * di bawahnya terlihat (Edit, Rename, Duplicate, Delete), seperti kartu di
 * app switcher. Geser turun atau ketuk foto untuk menutup. Rename terjadi di
 * nama di bawah strip.
 */
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { UiIconName } from './Icon';
import { sheetSpring } from '../motion';
import type { ProjectCard } from '../projects/projects';
import { recipeParts, relativeTime } from '../projects/format';
import { haptic } from '../haptics';
import { Icon } from './Icon';

/** Tekan lama untuk menu (ms), dan gerak yang membatalkannya (px). */
const HOLD_MS = 480;
const HOLD_SLOP = 10;

/** Tinggi baki aksi yang tersingkap (px) dan ambang geser untuk membukanya. */
const TRAY = 92;
const LIFT_AT = 36;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function RecentStrip({ cards, onOpen, onMenu, onRelink, onRename, onDuplicate, onDelete }: {
  cards: readonly ProjectCard[];
  onOpen: (card: ProjectCard) => void;
  onMenu: (card: ProjectCard, anchor: DOMRect) => void;
  onRelink: (card: ProjectCard) => void;
  onRename: (card: ProjectCard, name: string) => void;
  onDuplicate: (card: ProjectCard) => void;
  onDelete: (card: ProjectCard) => void;
}) {
  const [at, setAt] = useState(0);
  const [lifted, setLifted] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const lift = useMotionValue(0);
  const reduce = useReducedMotion();
  /** Seret vertikal barusan: klik yang menyusul bukan "buka proyek". */
  const dragged = useRef(false);
  const grabberOpacity = useTransform(lift, [-LIFT_AT, 0], [0, 1]);
  const slats = useRef<Array<HTMLDivElement | null>>([]);
  const hold = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  /** The press opened a closed slat: its click must not open the project too. */
  const openedOnPress = useRef(false);
  const index = Math.min(at, cards.length - 1);
  const card = cards[index];

  // Daftar berubah (dibuka, dihapus): yang terbaru di depan terbuka lagi.
  const firstId = cards[0]?.id;
  useEffect(() => setAt(0), [firstId, cards.length]);

  const setLift = (on: boolean) => {
    setLifted(on);
    if (reduce) lift.set(on ? -TRAY : 0);
    else void animate(lift, on ? -TRAY : 0, sheetSpring);
  };
  // Pindah bilah, atau daftar berubah: baki tertutup, rename batal.
  useEffect(() => {
    setLifted(false);
    lift.set(0);
    setRenaming(false);
  }, [index, firstId, cards.length, lift]);

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

  const actions: Array<{ label: string; icon: UiIconName; destructive?: boolean; run: (c: ProjectCard) => void }> = [
    { label: 'Edit', icon: 'rename', run: open },
    { label: 'Rename', icon: 'textCursor', run: () => setRenaming(true) },
    { label: 'Duplicate', icon: 'duplicate', run: onDuplicate },
    { label: 'Delete', icon: 'trash', destructive: true, run: onDelete },
  ];

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragged.current = false;
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
    else if (e.key === 'Escape' && lifted) { setLift(false); e.preventDefault(); }
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
                if (dragged.current) { dragged.current = false; return; }
                if (hold.current?.fired) { cancelHold(); return; }
                if (openedOnPress.current) { openedOnPress.current = false; return; }
                if (!isOpen) { show(i, false); return; }
                if (lifted) { setLift(false); return; }
                open(c);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                cancelHold();
                show(i, false);
                onMenu(c, e.currentTarget.getBoundingClientRect());
              }}
            >
              {isOpen && (
                <div className="recent-tray" role="group" aria-label={`${c.name} actions`} aria-hidden={!lifted}>
                  {actions.map((a) => (
                    <button
                      key={a.label}
                      type="button"
                      className="recent-action"
                      data-destructive={a.destructive || undefined}
                      tabIndex={lifted ? 0 : -1}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        haptic();
                        setLift(false);
                        a.run(c);
                      }}
                    >
                      <span className="recent-action-icon"><Icon name={a.icon} size={19} /></span>
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
              <motion.div
                className="recent-lift"
                style={isOpen ? { y: lift, touchAction: 'none' } : undefined}
                drag={isOpen ? 'y' : false}
                dragConstraints={{ top: -TRAY, bottom: 0 }}
                dragElastic={{ top: 0.12, bottom: 0.04 }}
                dragMomentum={false}
                onDragStart={() => { dragged.current = true; cancelHold(); }}
                onDragEnd={(_, info) => {
                  const next = lifted
                    ? !(info.offset.y > LIFT_AT || info.velocity.y > 300)
                    : info.offset.y < -LIFT_AT || info.velocity.y < -300;
                  if (next !== lifted) haptic();
                  setLift(next);
                }}
              >
                {c.thumb && !c.missing && <img className="recent-photo" src={c.thumb} alt="" draggable={false} />}
                {c.missing && <span className="recent-warn" aria-hidden="true"><Icon name="warning" size={22} /></span>}
                <span className="recent-num tabular" aria-hidden="true">{c.missing ? '!' : pad(i + 1)}</span>
                {isOpen && <motion.span className="recent-grabber" aria-hidden="true" style={{ opacity: grabberOpacity }} />}
              </motion.div>
            </div>
          );
        })}
      </div>
      <div className="recent-info">
        <div className="recent-text">
          <span className="recent-film" data-missing={card.missing || undefined}>{card.missing ? 'Missing original' : film}</span>
          {renaming ? (
            <RenameField
              name={card.name}
              onDone={(name) => {
                setRenaming(false);
                if (name && name !== card.name) onRename(card, name);
              }}
            />
          ) : (
            <strong>{card.name}</strong>
          )}
          <span>{card.missing ? 'Tap to choose the photo again' : `${rest} · ${relativeTime(card.updatedAt)}`}</span>
        </div>
      </div>
      {cards.length > 1 && (
        <div className="recent-dots" aria-hidden="true">
          {cards.map((c, i) => <i key={c.id} data-on={i === index || undefined} />)}
        </div>
      )}
    </section>
  );
}

/** Nama proyek yang bisa diketik langsung: Enter/keluar menyimpan, Escape membatalkan. */
function RenameField({ name, onDone }: { name: string; onDone: (name: string | undefined) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (value: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(value?.trim() || undefined);
  };
  return (
    <input
      ref={input}
      className="recent-rename"
      defaultValue={name}
      aria-label="Project name"
      enterKeyHint="done"
      maxLength={80}
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(e.currentTarget.value);
        else if (e.key === 'Escape') finish(undefined);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}
