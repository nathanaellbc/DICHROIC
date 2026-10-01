/**
 * Action sheet yang muncul dari kontrol pemicunya (DESIGN.md: action sheet
 * kini inline dari sumbernya), alert, dan toast konfirmasi singkat.
 */
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { useDialogKeys } from '../hooks';
import { overlay } from '../motion';
import { Icon } from './Icon';
import type { UiIconName } from './Icon';
import { activateModal } from '../modalFocus';

export interface SheetAction {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  icon?: UiIconName;
  /** Pintasan yang ditampilkan di sisi kanan (mis. ⌘Z). */
  shortcut?: string;
}

interface ActionSheetProps {
  open: boolean;
  anchor: DOMRect | null;
  /** Pertanyaan konfirmasi; tanpa pesan, action sheet menjadi menu. */
  message?: string;
  /** Label aksesibel menu tanpa pesan. */
  label?: string;
  /** Aksi destruktif di atas; Batal selalu di bawah (DESIGN.md: Action sheets). */
  actions: readonly SheetAction[];
  onCancel: () => void;
}

export function ActionSheet(props: ActionSheetProps) {
  return <AnimatePresence>{props.open && <ActionSheetBody {...props} />}</AnimatePresence>;
}

/** Muncul dari pemicunya: skala kecil (bukan 0,4) dengan pegas lembut. */
const menuSpring = { type: 'spring' as const, duration: 0.34, bounce: 0.14 };
/** Sorotan meluncur (Glide Select: 220 ms ease-out). */
const glideTransition = { type: 'spring' as const, duration: 0.24, bounce: 0 };

function ActionSheetBody({ anchor, message, label, actions, onCancel }: ActionSheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rows = useRef<Array<HTMLButtonElement | null>>([]);
  useDialogKeys(ref, onCancel, false);
  useEffect(() => {
    const cleanup = ref.current ? activateModal(ref.current) : undefined;
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    buttons.find((button) => !button.classList.contains('destructive'))?.focus({ preventScroll: true });
    return cleanup;
  }, []);
  const left = anchor ? Math.min(Math.max(12, anchor.left), window.innerWidth - 282) : 16;
  const top = anchor ? anchor.bottom + 8 : 100;

  // Sorotan: satu untuk seluruh menu, meluncur ke baris yang ditunjuk dan
  // diingat posisinya, jadi masuk lagi meluncur dari sana (Glide Select).
  const [hot, setHot] = useState<number | null>(null);
  const [glide, setGlide] = useState<{ y: number; h: number } | null>(null);
  const shown = useRef(false);
  useLayoutEffect(() => {
    if (hot === null) return;
    const row = rows.current[hot];
    if (row) setGlide({ y: row.offsetTop, h: row.offsetHeight });
  }, [hot]);

  // Sentuh: tekan baris, geser ke baris lain, lepas = pilih (seperti menu iOS).
  const press = useRef<{ id: number } | null>(null);
  const swallowClick = useRef(false);
  const rowAt = (clientY: number) => rows.current.findIndex((r) => {
    if (!r) return false;
    const b = r.getBoundingClientRect();
    return clientY >= b.top && clientY < b.bottom;
  });
  const items = [...actions.map((a) => ({ ...a, cancel: false })), { label: 'Cancel', onSelect: onCancel, cancel: true } as SheetAction & { cancel: boolean }];
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') return;
    press.current = { id: e.pointerId };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* sudah lepas */ }
    const i = rowAt(e.clientY);
    setHot(i >= 0 ? i : null);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') {
      const i = rowAt(e.clientY);
      if (i >= 0) setHot(i);
      return;
    }
    if (!press.current || press.current.id !== e.pointerId) return;
    const i = rowAt(e.clientY);
    setHot(i >= 0 ? i : null);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!press.current || press.current.id !== e.pointerId) return;
    press.current = null;
    const i = rowAt(e.clientY);
    swallowClick.current = true;
    setTimeout(() => { swallowClick.current = false; }, 0);
    if (i >= 0) items[i]!.onSelect();
    else setHot(null);
  };

  return (
    <>
      <div className="scrim" onClick={onCancel} aria-hidden="true" />
      <motion.div
        ref={ref}
        role={message ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-label={message ?? label}
        className="popover"
        style={{ left, top, transformOrigin: anchor ? `${anchor.left + anchor.width / 2 - left}px -8px` : 'top left' }}
        initial={{ opacity: 0, scale: 0.9, y: -4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.94, y: -4, transition: { duration: 0.14, ease: [0.4, 0, 1, 1] } }}
        transition={document.documentElement.dataset.size === 'regular' ? overlay() : menuSpring}
      >
        {message && <p className="t-footnote secondary" style={{ margin: 0, padding: '14px 16px 12px', textAlign: 'center' }}>{message}</p>}
        <div
          ref={listRef}
          className="popover-list"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { press.current = null; setHot(null); }}
          onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHot(null); }}
        >
          {glide && (
            <motion.span
              className="popover-glide"
              aria-hidden="true"
              initial={false}
              animate={{ y: glide.y, height: glide.h, opacity: hot === null ? 0 : 1 }}
              transition={shown.current ? glideTransition : { duration: 0, opacity: { duration: 0.12 } }}
              onAnimationComplete={() => { shown.current = hot !== null; }}
            />
          )}
          {items.map((a, i) => (
            <motion.button
              key={a.label}
              ref={(el) => { rows.current[i] = el; }}
              type="button"
              className={a.destructive ? 'popover-action destructive' : 'popover-action'}
              data-menu={message || a.cancel ? undefined : ''}
              initial={{ opacity: 0, y: -3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: 0.03 + i * 0.02, ease: [0.23, 1, 0.32, 1] }}
              // Fokus otomatis saat membuka (aksesibilitas) tidak menyorot di HP;
              // hanya fokus keyboard yang terlihat (:focus-visible).
              onFocus={(e) => { if (e.currentTarget.matches(':focus-visible')) setHot(i); }}
              data-hot={hot === i || undefined}
              onClick={() => { if (!swallowClick.current) a.onSelect(); }}
            >
              {a.icon && <Icon name={a.icon} size={18} />}
              <span style={{ flexGrow: 1 }}>{a.label}</span>
              {a.shortcut && <span className="t-footnote secondary" aria-hidden="true">{a.shortcut}</span>}
            </motion.button>
          ))}
        </div>
      </motion.div>
    </>
  );
}

interface AlertProps {
  open: boolean;
  title: string;
  message: string;
  onDismiss: () => void;
  actionLabel?: string;
}

export function Alert(props: AlertProps) {
  return <AnimatePresence>{props.open && <AlertBody {...props} />}</AnimatePresence>;
}

function AlertBody({ title, message, onDismiss, actionLabel = 'OK' }: AlertProps) {
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useDialogKeys(ref, onDismiss, false);
  useEffect(() => {
    if (ref.current) return activateModal(ref.current);
  }, []);
  useEffect(() => {
    buttonRef.current?.focus({ preventScroll: true });
  }, []);
  return (
        <>
          <motion.div className="alert-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} aria-hidden="true" />
          <motion.div
            ref={ref}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="alert-title"
            aria-describedby="alert-message"
            className="alert"
            style={{ x: '-50%', y: '-50%' }}
            initial={{ opacity: 0, scale: 1.12 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
            transition={overlay()}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h2 id="alert-title" className="t-headline" style={{ margin: 0 }}>{title}</h2>
              <p id="alert-message" className="t-footnote" style={{ margin: 0, color: 'rgba(235,235,245,0.75)' }}>{message}</p>
            </div>
            <button type="button" className="capsule" onClick={onDismiss}>{actionLabel}</button>
          </motion.div>
        </>
  );
}

export function Toast({ message, icon }: { message: string | null; icon?: UiIconName }) {
  return (
    <AnimatePresence>
      {message && (
        <motion.div
          role="status"
          className="toast glass t-subhead"
          style={{ x: '-50%' }}
          initial={{ opacity: 0, y: -16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -12, transition: { duration: 0.2 } }}
          transition={overlay()}
        >
          {icon && <Icon name={icon} size={18} color="var(--green)" strokeWidth={2.6} />}
          {message}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Spinner({ size = 20 }: { size?: number }): ReactNode {
  return <Icon name="loader" size={size} className="spinner" />;
}
