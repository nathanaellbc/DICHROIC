import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Toast } from './components/Overlays';
import { describeError, engine } from './engine/engine';
import { ACCEPTED_FILES, useEngineState, useFilePicker, useSizeClass } from './hooks';
import { fade } from './motion';
import { Editor } from './screens/Editor';
import { OpeningCard, StartScreen, UnsupportedScreen } from './screens/Start';

export function App() {
  const state = useEngineState();
  const size = useSizeClass();
  const wide = size.width === 'regular';
  const [toast, setToast] = useState<string | null>(null);
  const [localError, setLocalError] = useState<{ title: string; message: string } | null>(null);
  const toastTimer = useRef(0);

  useEffect(() => engine.start(), []);

  const openFile = useCallback((file: File) => void engine.openFile(file), []);
  const picker = useFilePicker(openFile);

  // Seret-lepas berkas di mana saja (desktop, iPad).
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      const file = e.dataTransfer?.files[0];
      if (!file) return;
      e.preventDefault();
      openFile(file);
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [openFile]);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  if (state.engine === 'unsupported') return <UnsupportedScreen />;

  const editing = !!state.frame && (state.phase === 'editing' || state.phase === 'opening');
  const error = state.error ?? localError;

  return (
    <>
      <input ref={picker.ref} type="file" accept={ACCEPTED_FILES} className="sr-only" tabIndex={-1} aria-hidden="true" />
      <AnimatePresence mode="wait" initial={false}>
        {editing ? (
          <motion.main key="editor" style={{ position: 'absolute', inset: 0 }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fade}>
            <Editor
              state={state}
              wide={wide}
              landscape={size.landscape}
              onOpenFile={picker.pick}
              onToast={showToast}
              onError={(e) => setLocalError(describeError(e))}
            />
          </motion.main>
        ) : (
          <motion.main key="start" style={{ position: 'absolute', inset: 0 }} initial={{ opacity: 0, scale: 0.985 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.01 }} transition={fade}>
            <StartScreen onChoose={picker.pick} wide={wide} engineReady={state.engine === 'ready'} engineFailed={state.engine === 'failed'} enginePaused={state.engine === 'paused'} />
          </motion.main>
        )}
      </AnimatePresence>
      <OpeningCard opening={state.phase === 'opening' ? state.opening : undefined} onCancel={() => engine.cancelOpening()} />
      <Alert
        open={!!error}
        title={error?.title ?? ''}
        message={error?.message ?? ''}
        onDismiss={() => {
          engine.dismissError();
          setLocalError(null);
        }}
      />
      <Toast message={toast} icon="check" />
    </>
  );
}
