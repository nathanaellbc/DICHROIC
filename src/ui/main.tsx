import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { engine } from './engine/engine';
import { startPwa } from './pwa';
import './styles.css';

startPwa();
// Hanya mode dev: probe Playwright membaca state engine yang sama dengan UI.
if (import.meta.env.DEV) Object.assign(window, { __dichroicEngine: engine });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* DESIGN.md (Motion): gerak opsional -- Reduce Motion mematikan transformasi, pudar tetap. */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
);
