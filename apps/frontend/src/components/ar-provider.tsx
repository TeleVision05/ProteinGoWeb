import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArViewer, type Challenge, type ChallengeOutcome, type ViewerStatus } from '@/ar/viewer';
import { apiOrigin, DEBUG_TOOLS } from '@/lib/config';
import type { ModelStyle, Spawn, StyleName } from '@/lib/types';

/** A question to answer in the scene before the protein is caught. */
export type EnterOptions = {
  challenge?: Challenge | null;
  /** Sends the chosen option to the server and says how it went. */
  onAnswer?: (index: number) => Promise<ChallengeOutcome>;
};

type ArApi = {
  status: ViewerStatus;
  /** Spawn whose model is loaded (or loading). */
  preparedId: string | null;
  /** 0..1, or -1 when unknown. */
  progress: number;
  error: string;
  /** True when this device can run WebXR AR; otherwise the 3D viewer (orbit and zoom) is the fallback. */
  arSupported: boolean;
  /** Model styles the prepared protein comes in (e.g. sphere, ribbon). One entry means no toggle. */
  styles: StyleName[];
  /** Style on screen (or loading) now. */
  style: StyleName | null;
  /** True while a style swap is still downloading. */
  swapping: boolean;
  /** Switch the prepared protein to another style. Works live, inside AR or the 3D viewer. */
  setStyle: (style: StyleName) => void;
  /** Start downloading a spawn's model so Inspect can open instantly. */
  prepare: (spawn: Spawn) => void;
  /** Call directly from a tap handler: AR can only start right after a user tap. Pass a challenge to ask a question first. */
  enter: (options?: EnterOptions) => void;
  /** Leave AR (or the preview) and return to the map. */
  exit: () => void;
};

const ArContext = createContext<ArApi | null>(null);

export function useAr() {
  const value = useContext(ArContext);
  if (!value) throw new Error('useAr must be used inside ArProvider');
  return value;
}


/** The style to show for a spawn: the player's last pick if it still exists, else the spawn's default. */
function pickEntry(spawn: Spawn, chosen: StyleName | undefined): ModelStyle | null {
  const list = spawn.styles ?? [];
  return (
    list.find((entry) => entry.style === chosen) ??
    list.find((entry) => entry.style === spawn.defaultStyle) ??
    list[0] ??
    null
  );
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
  const [arSupported, setArSupported] = useState(false);
  const [styles, setStyles] = useState<StyleName[]>([]);
  const [style, setStyleState] = useState<StyleName | null>(null);
  const [swapping, setSwapping] = useState(false);
  const arSupportedRef = useRef(false);
  // The prepared spawn, and the style the player last picked for each protein (survives list refreshes).
  const preparedRef = useRef<Spawn | null>(null);
  const chosenRef = useRef(new Map<string, StyleName>());
  const swapSeq = useRef(0);

  useEffect(() => {
    viewerRef.current?.setDevEnabled(devOn);
  }, [devOn]);

  useEffect(() => {
    navigator.xr
      ?.isSessionSupported('immersive-ar')
      .then((ok) => { arSupportedRef.current = ok; setArSupported(ok); })
      .catch(() => { arSupportedRef.current = false; setArSupported(false); });
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
      const entry = pickEntry(spawn, chosenRef.current.get(spawn.id));
      const url = entry?.url ?? spawn.modelUrl;
      if (!url) return;
      const viewer = getViewer();
      // Keyed by style and model URL (which carries a version), so an edited model reloads.
      const key = `${entry?.style ?? 'model'}|${url}`;
      preparedRef.current = spawn;
      setStyles((spawn.styles ?? []).map((item) => item.style));
      setStyleState(entry?.style ?? null);
      if (!viewer || viewer.loadedId === key) return;
      setError('');
      setProgress(-1);
      setPreparedId(spawn.id);
      setSwapping(false);
      swapSeq.current++;
      void viewer.load(key, new URL(url, apiOrigin).href, spawn.name, {
        lowUrl: entry?.lowUrl ? new URL(entry.lowUrl, apiOrigin).href : null,
      });
    },
    [getViewer],
  );

  const setStyle = useCallback((next: StyleName) => {
    const spawn = preparedRef.current;
    const viewer = viewerRef.current;
    const entry = spawn?.styles?.find((item) => item.style === next);
    if (!spawn || !viewer || !entry) return;
    const key = `${entry.style}|${entry.url}`;
    if (viewer.loadedId === key) return;
    const previous = chosenRef.current.get(spawn.id) ?? spawn.defaultStyle ?? null;
    chosenRef.current.set(spawn.id, next);
    setStyleState(next);
    setError('');
    setSwapping(true);
    const seq = ++swapSeq.current;
    void viewer
      .load(key, new URL(entry.url, apiOrigin).href, spawn.name, {
        lowUrl: entry.lowUrl ? new URL(entry.lowUrl, apiOrigin).href : null,
      })
      .then(() => {
        if (seq !== swapSeq.current) return; // a newer pick took over
        setSwapping(false);
        // The swap failed (the viewer kept the old model): show the style that is really on screen.
        if (viewer.loadedId !== key) {
          if (previous) chosenRef.current.set(spawn.id, previous);
          else chosenRef.current.delete(spawn.id);
          setStyleState(previous);
        }
      });
  }, []);

  const enter = useCallback((options?: EnterOptions) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    setError('');
    setDevOn(false);
    // Always set (or clear) the question, so a previous protein's question never carries over.
    viewer.setChallenge(options?.challenge ?? null, options?.onAnswer);
    if (arSupportedRef.current) viewer.enterAR();
    else viewer.enterPreview();
  }, []);

  const exit = useCallback(() => viewerRef.current?.exit(), []);

  // The Ribbon / Spheres switch lives in the scene; keep it in step with what is prepared and what is on screen.
  useEffect(() => {
    viewerRef.current?.setStyleToggle(styles, style, swapping, setStyle);
  }, [styles, style, swapping, setStyle, preparedId]);

  const api = useMemo<ArApi>(
    () => ({
      status, preparedId, progress, error, arSupported, styles, style, swapping, setStyle, prepare, enter, exit,
    }),
    [status, preparedId, progress, error, arSupported, styles, style, swapping, setStyle, prepare, enter, exit],
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
              <div className="flex items-center gap-2">
                <button className={btn} onClick={() => viewerRef.current?.exit()}>
                  ← Map
                </button>
              </div>
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
