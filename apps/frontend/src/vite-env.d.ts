/// <reference types="vite/client" />

declare const __BUILD__: string;

interface ImportMetaEnv {
  readonly VITE_MAPBOX_TOKEN: string;
  readonly VITE_API_URL?: string;
  readonly VITE_ENABLE_DEBUG_TOOLS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
