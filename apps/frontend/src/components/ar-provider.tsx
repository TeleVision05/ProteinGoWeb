import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArViewer, type ViewerStatus } from '@/ar/viewer';
import { apiOrigin, DEBUG_TOOLS } from '@/lib/config';
import type { Spawn } from '@/lib/types';

type ArApi = {
  status: ViewerStatus;
  /** Spawn whose model is loaded (or loading). */
  preparedId: string | null;
  /** 0..1, or -1 when unknown. */
  progress: number;
  error: string;
  /** Start downloading a spawn's model so Inspect can open instantly. */
  prepare: (spawn: Spawn) => void;
  /** Call directly from a tap handler: AR can only start right after a user tap. */
  enter: () => void;
  /** Leave AR (or the preview) and return to the map. */
  exit: () => void;
};

const ArContext = createContext<ArApi | null>(null);

export function useAr() {
  const value = useContext(ArContext);
  if (!value) throw new Error('useAr must be used inside ArProvider');
  return value;
}

const btn =
  'pointer-events-auto rounded-full bg-black/70 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-black/50 active:bg-black/90';

export function ArProvider({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const pinchRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ArViewer | null>(null);
  const [status, setStatus] = useState<ViewerStatus>('idle');
  const [preparedId, setPreparedId] = useState<string | null>(null);
  const [progress, setProgress] = useState(-1);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [devLines, setDevLines] = useState<string[]>([]);
  const [devOn, setDevOn] = useState(false);
  const [clipOn, setClipOn] = useState(true);
  const [autoRes, setAutoRes] = useState(true);
  const [shadow, setShadow] = useState('map');
  const arSupported = useRef(false);

  useEffect(() => {
    viewerRef.current?.setDevEnabled(devOn);
  }, [devOn]);

  useEffect(() => {
    navigator.xr
      ?.isSessionSupported('immersive-ar')
      .then((ok) => { arSupported.current = ok; })
      .catch(() => { arSupported.current = false; });
  }, []);

  useEffect(() => () => {
    viewerRef.current?.dispose();
    viewerRef.current = null;
  }, []);

  const getViewer = useCallback(() => {
    if (!viewerRef.current && containerRef.current && overlayRef.current) {
      viewerRef.current = new ArViewer(containerRef.current, overlayRef.current, {
        status: setStatus,
        progress: (fraction) => setProgress(fraction),
        hint: setHint,
        dev: setDevLines,
        error: setError,
      });
      if (pinchRef.current) viewerRef.current.bindPinch(pinchRef.current);
    }
    return viewerRef.current;
  }, []);

  const prepare = useCallback(
    (spawn: Spawn) => {
      if (!spawn.modelUrl) return;
      const viewer = getViewer();
      // Keyed by model URL (which carries a version), so an edited model reloads.
      if (!viewer || viewer.loadedId === spawn.modelUrl) return;
      setError('');
      setProgress(-1);
      setPreparedId(spawn.id);
      void viewer.load(spawn.modelUrl, new URL(spawn.modelUrl, apiOrigin).href, spawn.name);
    },
    [getViewer],
  );

  const enter = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    setError('');
    setDevOn(false);
    if (arSupported.current) viewer.enterAR();
    else viewer.enterPreview();
  }, []);

  const exit = useCallback(() => viewerRef.current?.exit(), []);

  const api = useMemo<ArApi>(
    () => ({ status, preparedId, progress, error, prepare, enter, exit }),
    [status, preparedId, progress, error, prepare, enter, exit],
  );

  const active = status === 'ar' || status === 'preview';

  return (
    <ArContext.Provider value={api}>
      {children}
      {createPortal(
        <>
          {/* Canvas host: shown for the desktop preview, and behind the AR session. */}
          <div
            ref={containerRef}
            className="fixed inset-0 z-50 bg-black"
            style={{ display: active ? 'block' : 'none' }}
          />
          {/* DOM overlay root: must sit directly under <body> so the browser can show it in AR. */}
          <div
            ref={overlayRef}
            className="pointer-events-none fixed inset-0 z-[60] font-sans"
            style={{ display: active ? 'block' : 'none' }}
          >
            {/* Catches two-finger pinches in AR. Single taps still reach the AR scene. */}
            <div
              ref={pinchRef}
              data-pinch=""
              className="absolute inset-0 touch-none"
              style={{ pointerEvents: status === 'ar' ? 'auto' : 'none' }}
            />
            <div className="absolute inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] flex items-start justify-between gap-2">
              <button className={btn} onClick={() => viewerRef.current?.exit()}>
                ← Map
              </button>
              {DEBUG_TOOLS ? (
                <button className={btn} onClick={() => setDevOn((on) => !on)}>
                  Dev: {devOn ? 'on' : 'off'}
                </button>
              ) : null}
            </div>
            {DEBUG_TOOLS && devOn ? (
              <div className="absolute top-[calc(max(0.75rem,env(safe-area-inset-top))+3.25rem)] right-3 grid gap-2">
                <pre className="pointer-events-none rounded-lg bg-black/60 p-2 font-mono text-[11px] leading-4 text-white">
                  {devLines.join('\n')}
                </pre>
                <button className={btn} onClick={() => setShadow(viewerRef.current?.cycleShadow() ?? 'map')}>
                  Shadow: {shadow}
                </button>
                <button className={btn} onClick={() => setAutoRes(viewerRef.current?.toggleAutoRes() ?? true)}>
                  Auto quality: {autoRes ? 'on' : 'off'}
                </button>
                <button className={btn} onClick={() => setClipOn(viewerRef.current?.toggleClip() ?? true)}>
                  Floor clip: {clipOn ? 'on' : 'off'}
                </button>
                {status === 'ar' ? (
                  <button className={btn} onClick={() => viewerRef.current?.toggleMove()}>
                    Move
                  </button>
                ) : null}
              </div>
            ) : null}
            {hint ? (
              <p className="absolute inset-x-6 bottom-[max(2rem,env(safe-area-inset-bottom))] text-center text-base font-medium text-white  rounded-lg bg-black/50 py-1 shadow-lg shadow-black/40">
                {hint}
              </p>
            ) : null}
          </div>
        </>,
        document.body,
      )}
    </ArContext.Provider>
  );
}
