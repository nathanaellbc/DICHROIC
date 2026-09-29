import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Toast } from './components/Overlays';
import { describeError, engine } from './engine/engine';
import { ACCEPTED_FILES, useEngineState, useFilePicker, useSizeClass } from './hooks';
import { Editor } from './screens/Editor';
import { OpeningCard, UnsupportedScreen } from './screens/Start';

export function App() {
  const state = useEngineState();
  const size = useSizeClass();
  const wide = size.width === 'regular';
  const [toast, setToast] = useState<string | null>(null);
  const [localError, setLocalError] = useState<{ title: string; message: string } | null>(null);
  const toastTimer = useRef(0);

  useEffect(() => engine.start(), []);

  // Kepadatan (styles.css): ukuran iOS di compact, kepadatan macOS di regular.
  useLayoutEffect(() => {
    document.documentElement.dataset.size = wide ? 'regular' : 'compact';
  }, [wide]);

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

  const error = state.error ?? localError;

  return (
    <>
      <input ref={picker.ref} type="file" accept={ACCEPTED_FILES} className="sr-only" tabIndex={-1} aria-hidden="true" />
      <main style={{ position: 'absolute', inset: 0 }}>
        <Editor
          state={state}
          wide={wide}
          landscape={size.landscape}
          onOpenFile={picker.pick}
          onToast={showToast}
          onError={(e) => setLocalError(describeError(e))}
        />
      </main>
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
