/**
 * Action sheet yang muncul dari kontrol pemicunya (DESIGN.md: action sheet
 * kini inline dari sumbernya), alert, dan toast konfirmasi singkat.
 */
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
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

function ActionSheetBody({ anchor, message, label, actions, onCancel }: ActionSheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogKeys(ref, onCancel, false);
  useEffect(() => {
    const cleanup = ref.current ? activateModal(ref.current) : undefined;
    const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    buttons.find((button) => !button.classList.contains('destructive'))?.focus({ preventScroll: true });
    return cleanup;
  }, []);
  const left = anchor ? Math.min(Math.max(12, anchor.left), window.innerWidth - 282) : 16;
  const top = anchor ? anchor.bottom + 8 : 100;
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
        initial={{ opacity: 0, scale: 0.4 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.16 } }}
        transition={overlay()}
      >
        {message && <p className="t-footnote secondary" style={{ margin: 0, padding: '14px 16px 12px', textAlign: 'center' }}>{message}</p>}
        {actions.map((a) => (
          <button key={a.label} type="button" className={a.destructive ? 'popover-action destructive' : 'popover-action'} onClick={a.onSelect} data-menu={message ? undefined : ''}>
            {a.icon && <Icon name={a.icon} size={18} />}
            <span style={{ flexGrow: 1 }}>{a.label}</span>
            {a.shortcut && <span className="t-footnote secondary" aria-hidden="true">{a.shortcut}</span>}
          </button>
        ))}
        <button type="button" className="popover-action" onClick={onCancel}>Cancel</button>
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
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="rgba(235,235,245,0.25)" strokeWidth="3" />
      <path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
