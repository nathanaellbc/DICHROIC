/**
 * Struk Undo setelah menghapus proyek (pola "Action receipts"): satu baris
 * tenang di bawah layar, cincin yang berkurang selama Undo masih bisa.
 */
import { AnimatePresence, motion } from 'motion/react';
import { UNDO_MS } from '../projects/projects';
import { overlay } from '../motion';

export function UndoReceipt({ deleted, onUndo }: { deleted?: { id: string; name: string }; onUndo: () => void }) {
  return (
    <AnimatePresence>
      {deleted && (
        <motion.div
          key={deleted.id}
          className="undo-receipt glass"
          role="status"
          aria-live="polite"
          initial={{ opacity: 0, y: 12, x: '-50%' }}
          animate={{ opacity: 1, y: 0, x: '-50%' }}
          exit={{ opacity: 0, y: 8, x: '-50%' }}
          transition={overlay()}
        >
          <svg className="undo-ring" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="8" />
            <circle cx="10" cy="10" r="8" className="undo-ring-time" style={{ animationDuration: `${UNDO_MS}ms` }} />
          </svg>
          <span className="undo-text">Deleted “{deleted.name}”</span>
          <button type="button" className="undo-action" onClick={onUndo}>Undo</button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
