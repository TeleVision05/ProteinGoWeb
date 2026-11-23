import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';
import { initVariantLaunch } from './lib/variant-launch';

// Start the iPhone WebXR SDK before React mounts: its init event can fire early.
void initVariantLaunch();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
