// Empty in dev (Vite proxies /api). Set VITE_API_URL to the hosted API origin for static deploys.
export const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
export const apiOrigin = API_URL || window.location.origin;

// Dev tools (FPS HUD, log, bench) in the AR viewer. On in local dev, off in deployed builds
// unless VITE_ENABLE_DEBUG_TOOLS=true.
export const DEBUG_TOOLS = import.meta.env.VITE_ENABLE_DEBUG_TOOLS
  ? import.meta.env.VITE_ENABLE_DEBUG_TOOLS === 'true'
  : import.meta.env.DEV;
