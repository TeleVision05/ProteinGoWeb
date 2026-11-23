// Variant Launch gives iPhones WebXR: Safari has none, so AR continues inside Variant's App Clip, which reloads
// this page there with WebXR available. Android Chrome has native WebXR and never loads the SDK.
// Needs VITE_VARIANT_LAUNCH_KEY; without it (or off iOS) this does nothing.

export type VariantLaunchState = {
  status: 'off' | 'ready' | 'error';
  /** 'launch-required' on iOS Safari (AR has to open in the App Clip); 'supported' inside it. */
  webXRStatus?: string;
  launchUrl?: string;
};

declare global {
  interface Window {
    VLaunch?: { getLaunchUrl?: (url: string) => string };
  }
}

const KEY = import.meta.env.VITE_VARIANT_LAUNCH_KEY;
const SDK_TIMEOUT_MS = 6000;

const isIos =
  typeof navigator !== 'undefined' &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

let started: Promise<VariantLaunchState> | null = null;

/** Loads the SDK (once) and resolves with its init payload. Call early: the init event can fire before React mounts. */
export function initVariantLaunch(): Promise<VariantLaunchState> {
  if (started) return started;
  started = new Promise<VariantLaunchState>((resolve) => {
    if (!KEY || !isIos) {
      resolve({ status: 'off' });
      return;
    }
    let settled = false;
    const finish = (state: VariantLaunchState) => {
      if (settled) return;
      settled = true;
      resolve(state);
    };
    const onInit = (event: Event) => {
      const detail = ((event as CustomEvent).detail ?? {}) as Record<string, unknown>;
      finish({
        status: 'ready',
        webXRStatus: typeof detail.webXRStatus === 'string' ? detail.webXRStatus : undefined,
        launchUrl: typeof detail.launchUrl === 'string' ? detail.launchUrl : undefined,
      });
    };
    window.addEventListener('vlaunch-initialized', onInit);
    document.addEventListener('vlaunch-initialized', onInit);
    const script = document.createElement('script');
    script.src = `https://launchar.app/sdk/v1?key=${encodeURIComponent(KEY)}`;
    script.onerror = () => finish({ status: 'error' });
    document.head.appendChild(script);
    window.setTimeout(() => finish({ status: 'error' }), SDK_TIMEOUT_MS);
  });
  return started;
}

/** True when this page is running inside Variant's iOS viewer (the App Clip), where WebXR comes from its polyfill. */
export const inVariantViewer = typeof navigator !== 'undefined' && navigator.userAgent.includes('Variant Launch');

let cameraWarmed = false;

/**
 * Asks for camera access as soon as the page opens in Variant's viewer, then lets the camera go. The first AR start
 * there showed a black camera until AR was restarted, which fits iOS asking for camera access only at that first
 * start. Settling the permission now means the first start already has it. Safe to call more than once, and a
 * refusal or an unsupported browser is ignored (AR then behaves as before).
 */
export function warmUpCamera(): void {
  if (cameraWarmed || !inVariantViewer || !navigator.mediaDevices?.getUserMedia) return;
  cameraWarmed = true;
  navigator.mediaDevices
    .getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    .then((stream) => stream.getTracks().forEach((track) => track.stop()))
    .catch(() => undefined);
}

/** The link that opens this page in the App Clip, with the protein to open once it is there. */
export function variantLaunchUrl(state: VariantLaunchState, spawnId: string | null): string | null {
  const target = new URL(window.location.href);
  if (spawnId) target.searchParams.set('vlspawn', spawnId);
  return window.VLaunch?.getLaunchUrl?.(target.href) || state.launchUrl || null;
}
