import { MotionConfig } from 'motion/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startPwa } from './pwa';
import './styles.css';

startPwa();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* DESIGN.md (Motion): gerak opsional -- Reduce Motion mematikan transformasi, pudar tetap. */}
    <MotionConfig reducedMotion="user">
      <App />
    </MotionConfig>
  </StrictMode>,
);
