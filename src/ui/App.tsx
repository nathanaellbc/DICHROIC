import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { installSquircleGeometry } from './squircle';
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
  useLayoutEffect(() => installSquircleGeometry(), []);

  // Kepadatan (styles.css): ukuran iOS di compact, kepadatan macOS di regular.
  useLayoutEffect(() => {
    document.documentElement.dataset.size = wide ? 'regular' : 'compact';
    // HP lanskap: tata letak PC, dengan panel sempit dan safe area (styles.css).
    if (size.phone) document.documentElement.dataset.phone = '';
    else delete document.documentElement.dataset.phone;
  }, [wide, size.phone]);

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

  const showToast = useCallback((message: string, ms = 2200) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);

  // Pesan engine tak memblokir (mis. pulih dari GPU yang ditarik sistem).
  useEffect(() => {
    if (!state.notice) return;
    showToast(state.notice, 4000);
    engine.dismissNotice();
  }, [state.notice, showToast]);

  // Ke latar tanpa foto: lepas GPU lebih dulu (iOS menariknya juga), siapkan lagi saat kembali.
  useEffect(() => {
    const onVisibility = () => engine.setBackground(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  if (state.engine === 'unsupported') return <UnsupportedScreen />;

  const error = state.error ?? localError;

  return (
    <>
      <input ref={picker.ref} type="file" accept={ACCEPTED_FILES} className="sr-only" tabIndex={-1} aria-hidden="true" data-modal-exempt="" />
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
