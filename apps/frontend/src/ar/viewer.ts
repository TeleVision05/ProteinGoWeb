import * as THREE from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { disposeSprite, factFor, makeFactCard, makeQuizPanel, makeThoughtBubble, type QuizPhase } from './sprites';
import { makePedestal, pedestalHeightFor, type ConsoleAction, type ConsoleState, type StyleChoice } from './pedestal';

export type ViewerStatus = 'idle' | 'loading' | 'ready' | 'ar' | 'preview';

export type ViewerEvents = {
  status(status: ViewerStatus): void;
  /** 0..1, or -1 when the size is unknown. */
  progress(fraction: number, text: string): void;
  hint(text: string): void;
  dev(lines: string[]): void;
  error(message: string): void;
  /** A question is waiting to be answered in the scene (true), or it has been answered or closed (false). */
  challenge?(active: boolean): void;
};

/** A question asked in the scene before the protein can be caught. */
export type Challenge = { question: string; options: string[] };

/** What the app says about an answer. `fatal` ends the session (e.g. the catch was refused for another reason). */
export type ChallengeOutcome =
  | { ok: true; message?: string }
  | { ok: false; message: string; retryAfterMs?: number; fatal?: boolean };

type QuizState = {
  panel: ReturnType<typeof makeQuizPanel>;
  answer: (index: number) => Promise<ChallengeOutcome>;
  phase: QuizPhase;
  picked: number;
  message: string;
  /** performance.now() time when options can be tapped again after a wrong answer. */
  lockedUntil: number;
  secondsLeft: number;
};

// Best to worst. Only the protein casts a shadow; the floating UI never does.
type ShadowTier = 'map' | 'blob' | 'off';
const SHADOW_ORDER: ShadowTier[] = ['map', 'blob', 'off'];

/** One detail level of a protein: its scene graph and animation. */
type Level = {
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer | null;
  actions: THREE.AnimationAction[];
  duration: number;
  counts: { vertices: number; triangles: number } | null;
};

/** Size and floor-centring offset shared by every detail level of one protein. */
type Frame = { size: THREE.Vector3; offset: THREE.Vector3 };

type Loaded = {
  id: string;
  name: string;
  url: string;
  /** Group in the scene: holds the model, or a THREE.LOD of both levels once the full one has arrived. */
  template: THREE.Object3D;
  size: THREE.Vector3;
  /** Primary mixer (full detail when loaded) and its actions, for the animation panel. */
  mixer: THREE.AnimationMixer | null;
  /** Every level's mixer: all are advanced together so the animation matches whichever level shows. */
  mixers: THREE.AnimationMixer[];
  actions: THREE.AnimationAction[];
  duration: number;
  lod: THREE.LOD | null;
  low: Level | null;
  high: Level | null;
};

const UP = new THREE.Vector3(0, 1, 0);
const MOBILE_VERTEX_BUDGET = 4_000_000;
// The low-detail copy takes over once the camera is farther than this many model-sizes away
// (hysteresis stops it flickering at the boundary). Distances are set from the displayed size in layout().
const LOD_SWITCH_SIZES = 3.2;
const LOD_HYSTERESIS = 0.15;
const TARGET_FPS = 60;
const TARGET_MS = 1000 / TARGET_FPS;
const TARGET_SIZE = 1.1; // metres, longest side of the protein (before pinch resizing)
const PEDESTAL_HEIGHT = 0.9; // metres: about waist height, so the screen is easy to reach and read
const PEDESTAL_MAX = 1.4;
const HEIGHT_KEY = 'proteingo.pedestalHeight';
const MIN_USER_SCALE = 0.2;
const MAX_USER_SCALE = 5;
const JSM = `https://cdn.jsdelivr.net/npm/three@0.${THREE.REVISION}.0/examples/jsm/`;

type GlbJson = {
  accessors?: { count: number }[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number }[] }[];
};

/** Vertex and triangle totals, read from the GLB header (works for Draco and meshopt files too). */
function glbCounts(json: GlbJson) {
  let vertices = 0;
  let triangles = 0;
  for (const mesh of json.meshes ?? []) {
    for (const prim of mesh.primitives) {
      const v = json.accessors?.[prim.attributes.POSITION]?.count ?? 0;
      vertices += v;
      triangles += (prim.indices != null ? json.accessors?.[prim.indices]?.count ?? 0 : v) / 3;
    }
  }
  return { vertices, triangles };
}

/**
 * Downloads a model. If the size is known it fills one pre-sized buffer (no second copy in memory).
 * `inspect` sees the GLB header as soon as it has arrived and may throw to stop the download.
 */
async function fetchBytes(
  url: string,
  onProgress: (got: number, total: number) => void,
  inspect?: (json: GlbJson) => void,
) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Model download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get('X-Decoded-Length') || (res.headers.get('Content-Encoding') ? 0 : res.headers.get('Content-Length')) || 0);
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  let target: Uint8Array | null = total ? new Uint8Array(total) : null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  let head: Uint8Array | null = inspect ? new Uint8Array(0) : null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (target && received + value.length <= target.length) {
      target.set(value, received);
    } else {
      if (target) { chunks.push(target.subarray(0, received)); target = null; }
      chunks.push(value);
    }
    received += value.length;
    onProgress(received, total);

    if (head && inspect) {
      const merged: Uint8Array = new Uint8Array(head.length + value.length);
      merged.set(head);
      merged.set(value, head.length);
      head = merged;
      if (head.length >= 20) {
        const jsonLen = new DataView(head.buffer, head.byteOffset).getUint32(12, true);
        if (jsonLen > 16 * 1024 * 1024) head = null; // not a normal GLB header; let the parser report it
        else if (head.length >= 20 + jsonLen) {
          try {
            inspect(JSON.parse(new TextDecoder().decode(head.subarray(20, 20 + jsonLen))) as GlbJson);
          } catch (e) {
            void reader.cancel();
            throw e;
          }
          head = null;
        }
      }
    }
  }
  if (target && received === target.length) return target.buffer as ArrayBuffer;
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

// GPU time per frame via EXT_disjoint_timer_query_webgl2. Many phones do not expose it; then it reads n/a.
class GpuTimer {
  private readonly ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  private active: WebGLQuery | null = null;
  private pending: WebGLQuery[] = [];
  lastMs: number | null = null;

  constructor(private readonly gl: WebGL2RenderingContext) {
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  get supported() { return !!this.ext; }

  begin() {
    if (!this.ext || this.active || this.pending.length > 6) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }

  end() {
    if (!this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
    const q = this.pending[0];
    if (!this.gl.getQueryParameter(q, this.gl.QUERY_RESULT_AVAILABLE)) return;
    this.pending.shift();
    if (!this.gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      this.lastMs = (this.gl.getQueryParameter(q, this.gl.QUERY_RESULT) as number) / 1e6;
    }
    this.gl.deleteQuery(q);
  }
}

export class ArViewer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.01, 200);
  private readonly controls: OrbitControls;
  private readonly loader: GLTFLoader;
  private readonly grid = new THREE.GridHelper(4, 16, 0x3a424d, 0x2a3038);
  private readonly previewBg = new THREE.Color(0x1b1f25);

  // anchorGroup follows the detected floor; content is the (scaled) protein inside it.
  private readonly anchorGroup = new THREE.Group();
  private readonly content = new THREE.Group();
  private readonly reticle: THREE.Mesh;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1.4);
  private readonly shadowCatcher: THREE.Mesh;
  private shadowRadius = 1;
  private shadowTier: ShadowTier = 'map';
  private shadowCeiling: ShadowTier = 'map'; // best tier allowed (lowered if upgrading keeps causing slowdowns)
  private lastShadowUpgradeAt = 0;
  private readonly blob: THREE.Mesh;
  private shadowDirty = true;
  private lastAnchorSig = 0;
  private readonly bubble = makeThoughtBubble();
  private readonly hitBox = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ visible: false }));
  private card: THREE.Mesh | null = null;
  // The protein stands on a pedestal; everything that belongs on top of it (protein, bubble, cards) lives in `raised`.
  private readonly raised = new THREE.Group();
  private readonly pedestal = makePedestal();
  private pedestalH = 0.3;
  private pedestalMin = 0.5;
  // The height the player chose (kept between visits); the pedestal never goes below what its screen needs.
  private pedestalPref = ((): number => {
    try {
      const saved = Number(localStorage.getItem(HEIGHT_KEY));
      if (saved >= 0.3 && saved <= PEDESTAL_MAX) return saved;
    } catch { /* storage unavailable */ }
    return PEDESTAL_HEIGHT;
  })();
  // The screen that slides out of the pedestal: which way it faces, and how far out it is.
  private readonly consoleDir = new THREE.Vector3(0, 0, 1);
  private consoleSnap = true;
  private consoleWant = 0;
  private consoleOpen = 0;
  private consoleDrawn = 0;
  private styleControl: { options: StyleChoice[]; active: StyleChoice; busy: boolean; pick: (style: StyleChoice) => void } | null = null;
  private quiz: QuizState | null = null;

  private readonly raycaster = new THREE.Raycaster();
  // Depth-only floor: writes depth but no colour, so anything below the floor fails the depth test.
  // Much cheaper than clipping planes, which add a per-pixel discard to every shader.
  private readonly floorOccluder = new THREE.Mesh(
    new THREE.CircleGeometry(6, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide }),
  );

  private model: Loaded | null = null;
  private loadToken = 0;
  private loadingId: string | null = null;
  private modelCounts: { vertices: number; triangles: number } | null = null;
  private mode: ViewerStatus = 'idle';

  // XR
  private session: XRSession | null = null;
  private refSpace: XRReferenceSpace | null = null;
  private hitTestSource: XRHitTestSource | null = null;
  private viewerSpace: XRReferenceSpace | null = null;
  // No floor found yet: after a few seconds the hit test is retried with more surface types, and after a few
  // more the player can place the protein in front of them by hand (some AR bridges, e.g. iOS, report no planes).
  private noHitSince = 0;
  private hitTestRetried = false;
  private manualPlaceReady = false;
  private lastHit: XRHitTestResult | null = null;
  private readonly lastHitMatrix = new THREE.Matrix4();
  private hitHorizontal = false;
  private placed = false;
  private locked = false;
  private anchor: XRAnchor | null = null;
  private readonly anchorOffset = new THREE.Matrix4();
  private readonly viewerPos = new THREE.Vector3();
  private trackingLost = 0;
  private wasTracking = true;
  private exiting = false;
  private frameCount = 0;
  private lastT = 0;
  private trackingText = '-';
  private clipEnabled = true;
  private userScale = 1; // set by pinching
  private bubbleBase = 1;
  private bubbleBob = 0.02;
  private animPlaying = true;
  private animSpeed = 1;
  private pinchEndedAt = 0;
  private devEnabled = false;
  private gpuTimer: GpuTimer | null = null;
  private gl!: WebGL2RenderingContext;
  private fences: { sync: WebGLSync; t: number }[] = [];
  private gpuDone = 0;
  private completions: number[] = []; // times the GPU finished a frame, last second only
  private lastChange = 'none';
  private gpuLatency = 0;
  private backlogAvg = 0;

  // Frame statistics (rolling 1 s window) and dynamic resolution.
  private readonly dts: number[] = [];
  private poseChanges = 0;
  private prevPose: number[] | null = null;
  private statWindowStart = 0;
  private fpsText: string[] = [];
  private resScale = 1;
  private autoRes = true;
  private readonly recentDts: number[] = [];
  private resCeiling = 1; // best resolution allowed (lowered if raising it keeps causing slowdowns)
  private lastResUpgradeAt = 0;
  private placedAt = 0;
  private slowFrames = 0;
  private fastFrames = 0;

  private readonly tmpV = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpM = new THREE.Matrix4();
  private pointerDown: { x: number; y: number } | null = null;
  private readonly onResize = () => this.resize();

  constructor(
    private readonly container: HTMLElement,
    private readonly overlay: HTMLElement,
    private readonly events: ViewerEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'high-performance' });
    this.shrinkCanvas();
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.xr.enabled = true;
    this.gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.gpuTimer = new GpuTimer(this.gl);
    this.renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
    container.appendChild(this.renderer.domElement);

    this.scene.background = this.previewBg;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.9;
    pmrem.dispose();
    // Real shadow map on an invisible floor. It only re-renders when something changed (see onFrame),
    // because drawing a heavy model a second time for the shadow pass is expensive on phones.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.bias = -0.0005;
    this.sun.position.set(0.6, 1.6, 0.9);
    this.scene.add(this.sun, this.sun.target, this.grid, this.anchorGroup);

    this.camera.position.set(1.4, 1.1, 1.8);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0.6, 0);
    this.controls.enableDamping = true;

    this.anchorGroup.matrixAutoUpdate = false;
    this.anchorGroup.add(this.pedestal.group, this.raised);
    this.raised.add(this.content);

    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.07, 0.09, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x4fd1a5, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.reticle.add(new THREE.Mesh(new THREE.CircleGeometry(0.012, 16).rotateX(-Math.PI / 2), this.reticle.material as THREE.Material));
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    this.reticle.renderOrder = 10;
    this.scene.add(this.reticle);

    this.shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.4 }),
    );
    this.shadowCatcher.receiveShadow = true;
    this.shadowCatcher.position.y = 0.001;
    this.shadowCatcher.visible = false;

    // Soft blob shadow: the cheap fallback when the shadow map is too slow.
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,0.55)');
    grd.addColorStop(0.6, 'rgba(0,0,0,0.25)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 128, 128);
    this.blob = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }),
    );
    this.blob.position.y = 0.002;
    this.blob.visible = false;
    this.bubble.visible = false;
    this.raised.add(this.shadowCatcher, this.blob, this.bubble);
    this.content.add(this.hitBox);

    this.floorOccluder.position.y = -0.003; // 3 mm margin so the base never flickers
    this.floorOccluder.renderOrder = -1;
    this.anchorGroup.add(this.floorOccluder);

    this.loader = new GLTFLoader();
    this.loader.setDRACOLoader(new DRACOLoader().setDecoderPath(`${JSM}libs/draco/gltf/`));
    this.loader.setKTX2Loader(new KTX2Loader().setTranscoderPath(`${JSM}libs/basis/`).detectSupport(this.renderer));
    this.loader.setMeshoptDecoder(MeshoptDecoder);

    // Taps on overlay buttons must not also count as taps in the AR scene. The pinch layer lets taps through.
    overlay.addEventListener('beforexrselect', (e) => {
      if (!(e.target instanceof HTMLElement && e.target.dataset.pinch !== undefined)) e.preventDefault();
    });

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => { this.pointerDown = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => this.onPointerUp(e));
    addEventListener('resize', this.onResize);
    this.resize();
  }

  // ----------------------------------------------------------------------------------------
  // Loading
  // ----------------------------------------------------------------------------------------

  /** Key of the loaded model, or of the one currently downloading. */
  get loadedId() { return this.loadingId ?? this.model?.id ?? null; }

  /** Which detail level is on screen right now: 0 = full detail, 1 = the low-detail copy. */
  get lodLevel(): 0 | 1 {
    const m = this.model;
    if (!m) return 0;
    if (m.lod) return m.lod.getCurrentLevel() === 0 ? 0 : 1;
    return m.high ? 0 : 1;
  }

  /**
   * Download and parse one GLB into a scene graph that is not in the scene yet.
   * `report` shows download progress (the first level only; background loads stay quiet).
   */
  private async fetchLevel(url: string, name: string, report: boolean, token: number): Promise<Level | null> {
    // Phones run out of memory on very large meshes, so refuse those before downloading all of it.
    const budget = matchMedia('(pointer: coarse)').matches ? MOBILE_VERTEX_BUDGET : Infinity;
    let counts: { vertices: number; triangles: number } | null = null;
    let bytes: ArrayBuffer | null = await fetchBytes(
      url,
      (got, total) => { if (report) this.events.progress(total ? got / total : -1, `Downloading ${name}…`); },
      (json) => {
        const found = glbCounts(json);
        counts = found;
        if (found.vertices > budget) {
          throw new Error(
            `${name} has ${(found.vertices / 1e6).toFixed(1)}M vertices and ${(found.triangles / 1e6).toFixed(1)}M triangles, too heavy for a phone ` +
              `(limit ${(budget / 1e6).toFixed(0)}M vertices). Pick a lighter version of it in /admin.`,
          );
        }
      },
    );
    if (token !== this.loadToken) return null;
    if (report) this.events.progress(-1, 'Preparing model…');
    const gltf = await this.loader.parseAsync(bytes, '');
    bytes = null; // the download buffer is no longer needed
    if (token !== this.loadToken) return null;

    const root = gltf.scene;
    let mixer: THREE.AnimationMixer | null = null;
    let actions: THREE.AnimationAction[] = [];
    let duration = 0;
    if (gltf.animations.length) {
      mixer = new THREE.AnimationMixer(root);
      actions = gltf.animations.map((clip) => mixer!.clipAction(clip));
      for (const action of actions) action.play();
      duration = Math.max(...gltf.animations.map((clip) => clip.duration));
    }
    return { root, mixer, actions, duration, counts };
  }

  /** Put a freshly parsed level in place: bottom-centre at the origin, shadows on, CPU geometry freed. */
  private prepareLevel(level: Level, frame: Frame | null): Frame {
    const root = level.root;
    root.updateMatrixWorld(true);
    let size: THREE.Vector3;
    let offset: THREE.Vector3;
    if (frame) {
      ({ size, offset } = frame);
    } else {
      const box = new THREE.Box3().setFromObject(root);
      size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      offset = new THREE.Vector3(-center.x, -box.min.y, -center.z);
    }
    // Both detail levels share one frame (the first one loaded), so they line up exactly.
    root.position.add(offset);
    this.releaseCpuGeometry(root);
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    return { size, offset };
  }

  /**
   * Load a model. With `lowUrl` the small low-detail copy is shown first (ready quickly) and the full model
   * arrives in the background; the viewer then switches between them by distance. Called while AR or the 3D
   * preview is already showing a model, it swaps the model in place without leaving AR.
   */
  async load(id: string, url: string, name: string, opts: { lowUrl?: string | null } = {}) {
    if (this.loadingId === id) return;
    if (this.model?.id === id) {
      // Asked for what is already on screen: drop any swap still in flight.
      if (this.loadingId) { this.loadToken++; this.loadingId = null; }
      return;
    }
    const swap = (this.mode === 'ar' || this.mode === 'preview') && !!this.model;
    const lowUrl = opts.lowUrl && opts.lowUrl !== url ? opts.lowUrl : null;
    const token = ++this.loadToken;
    if (!swap) {
      this.unload();
      this.setStatus('loading');
    }
    this.loadingId = id;
    try {
      // First level to show: the low copy when there is one, otherwise the model itself.
      const first = await this.fetchLevel(lowUrl ?? url, name, true, token);
      if (!first || token !== this.loadToken) return;
      const frame = this.prepareLevel(first, null);
      const holder = new THREE.Group();
      holder.add(first.root);
      const next: Loaded = {
        id, name, url,
        template: holder,
        size: frame.size,
        mixer: first.mixer,
        mixers: first.mixer ? [first.mixer] : [],
        actions: first.actions,
        duration: first.duration,
        lod: null,
        low: lowUrl ? first : null,
        high: lowUrl ? null : first,
      };
      this.modelCounts = first.counts;
      this.installModel(next, swap);
      await this.renderer.compileAsync(this.scene, this.camera);
      if (token !== this.loadToken) return;
      this.events.progress(1, 'Ready');
      this.loadingId = null;
      if (!swap) this.setStatus('ready');
      if (lowUrl) void this.upgradeToHigh(next, url, name, token, frame);
    } catch (e) {
      if (token !== this.loadToken) return;
      this.loadingId = null;
      // A failed live swap leaves the current model alone; a failed first load goes back to idle.
      if (!swap) this.setStatus('idle');
      this.events.error(e instanceof Error ? e.message : 'Could not load that model.');
    }
  }

  /** Make `next` the model on screen. A model already showing is replaced in the same step and freed. */
  private installModel(next: Loaded, keepUserScale: boolean) {
    const old = this.model;
    // Where the animation was, so a style swap carries on from the same moment (and stays paused if it was).
    const oldTime = old?.actions[0] ? old.actions[0].time % (old.duration || 1) : 0;
    if (old) {
      this.closeFact();
      this.content.remove(old.template);
      this.freeModel(old);
    }
    if (!keepUserScale) {
      this.userScale = 1;
      this.animPlaying = true;
      this.animSpeed = 1;
    } else {
      for (const mixer of next.mixers) {
        mixer.timeScale = this.animSpeed;
        mixer.setTime(next.duration ? oldTime % next.duration : 0);
      }
    }
    this.content.add(next.template);
    this.model = next;
    this.layout();
    this.shadowDirty = true;
  }

  /** Background step: fetch the full-detail model and add it as the near level. Quietly keeps the low copy on failure. */
  private async upgradeToHigh(model: Loaded, url: string, name: string, token: number, frame: Frame) {
    try {
      const high = await this.fetchLevel(url, name, false, token);
      if (!high) return;
      if (token !== this.loadToken || this.model !== model) {
        this.disposeLevel(high);
        return;
      }
      this.prepareLevel(high, frame);
      const low = model.low!;
      const lod = new THREE.LOD();
      lod.addLevel(high.root, 0);
      lod.addLevel(low.root, 1, LOD_HYSTERESIS);
      model.template.remove(low.root);
      model.template.add(lod);
      model.lod = lod;
      model.high = high;
      // Keep the animation in step with the copy that has been playing so far.
      if (high.mixer) {
        high.mixer.setTime(low.actions[0]?.time ?? 0);
        high.mixer.timeScale = this.animSpeed;
        model.mixers.push(high.mixer);
        model.mixer = high.mixer;
        model.actions = high.actions;
        model.duration = high.duration;
      }
      this.modelCounts = high.counts ?? this.modelCounts;
      this.layout();
      this.shadowDirty = true;
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch (e) {
      // Too heavy for this phone, or the download failed: the low-detail model stays on screen.
      console.warn('Full-detail model not loaded:', e instanceof Error ? e.message : e);
    }
  }

  /** Once geometry is on the GPU, the CPU copy of every vertex array is dead weight: free it. */
  private releaseCpuGeometry(root: THREE.Object3D) {
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geometry = mesh.geometry;
      geometry.computeBoundingSphere(); // needed for culling, and it reads the arrays
      geometry.computeBoundingBox();
      const attrs = [...Object.values(geometry.attributes), ...(geometry.index ? [geometry.index] : [])];
      for (const attr of attrs) {
        if (!(attr as THREE.BufferAttribute).isBufferAttribute) continue;
        (attr as THREE.BufferAttribute).onUpload(function (this: THREE.BufferAttribute) {
          (this as unknown as { array: unknown }).array = null;
        });
      }
    });
  }

  private disposeLevel(level: Level) {
    level.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const value of Object.values(mat)) if (value instanceof THREE.Texture) value.dispose();
        mat.dispose();
      }
    });
    level.mixer?.stopAllAction();
  }

  /** Free everything a model holds on the GPU (both detail levels). */
  private freeModel(model: Loaded) {
    if (model.low) this.disposeLevel(model.low);
    if (model.high) this.disposeLevel(model.high);
    model.lod?.clear();
  }

  private unload() {
    this.closeFact();
    if (!this.model) return;
    this.content.remove(this.model.template);
    this.freeModel(this.model);
    this.userScale = 1;
    this.model = null;
    this.modelCounts = null;
    this.layout();
  }

  private scale() {
    if (!this.model) return 1;
    return (TARGET_SIZE * this.userScale) / Math.max(this.model.size.x, this.model.size.y, this.model.size.z);
  }

  private layout() {
    const m = this.model;
    this.bubble.visible = !!m && !this.card && !this.quiz;
    this.applyShadowTier();
    this.pedestal.group.visible = !!m;
    if (!m) return;
    const s = this.scale();
    this.content.scale.setScalar(s);
    // The protein stands on a pedestal, and the control screen slides out of it.
    this.pedestal.setState(this.consoleState());
    const bigSide = Math.max(m.size.x, m.size.y, m.size.z) * s;
    const screenW = Math.max(bigSide * 0.5, 0.34);
    const edge = Math.max(m.size.x, m.size.z) * s * 0.5;
    const baseR = Math.max(edge * 0.95, bigSide * 0.28, screenW * 0.75);
    this.pedestalMin = pedestalHeightFor(screenW / this.pedestal.aspect);
    this.pedestalH = Math.min(PEDESTAL_MAX, Math.max(this.pedestalPref, this.pedestalMin));
    this.pedestal.setState(this.consoleState()); // now showing the final height and range
    this.pedestal.layout(baseR, this.pedestalH, screenW);
    this.raised.position.y = this.pedestalH;
    // Thought bubble floats just above the top of the protein.
    // Everything floating around the protein is sized from the protein's current size, so it scales with pinch zoom.
    const unit = Math.max(m.size.x, m.size.y, m.size.z) * s;
    // Low-detail copy takes over beyond a few model-sizes away, so it follows the pinch zoom as well.
    if (m.lod && m.lod.levels[1]) m.lod.levels[1].distance = unit * LOD_SWITCH_SIZES;
    const width = unit * 0.28;
    this.bubbleBase = m.size.y * s + unit * 0.035;
    this.bubbleBob = unit * 0.022;
    this.bubble.scale.set(width, width / this.bubble.userData.aspect, 1);
    this.bubble.position.set(0, this.bubbleBase, 0);
    // Shadow frustum wraps the protein, and the catcher is a bit bigger than that.
    this.shadowRadius = Math.max(m.size.x, m.size.y, m.size.z) * s * 0.8 + 0.1;
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -this.shadowRadius;
    cam.right = cam.top = this.shadowRadius;
    cam.near = 0.01;
    cam.far = this.shadowRadius * 6;
    cam.updateProjectionMatrix();
    // Shadows fall on the pedestal's top, so they stop at its rim.
    const reach = Math.min(this.shadowRadius * 2.4, baseR * 1.35);
    this.shadowCatcher.scale.set(reach, 1, reach);
    const foot = Math.min(Math.max(m.size.x, m.size.z) * s * 1.4, baseR * 1.9);
    this.blob.scale.set(foot, 1, foot);
    this.hitBox.scale.copy(m.size);
    this.hitBox.position.set(0, m.size.y / 2, 0);
    if (this.card) this.placeCard();
    if (this.quiz) this.placeQuiz();
  }

  // ----------------------------------------------------------------------------------------
  // Fun-fact card
  // ----------------------------------------------------------------------------------------

  private placeCard() {
    if (!this.model || !this.card) return;
    const s = this.scale();
    const m = this.model;
    const unit = Math.max(m.size.x, m.size.y, m.size.z) * s;
    const width = unit * 0.42;
    const height = width / this.card.userData.aspect;
    this.card.scale.set(width, height, 1);
    this.card.position.set(0, m.size.y * s + unit * 0.07 + height / 2, 0);
  }

  private closeFact() {
    disposeSprite(this.card);
    this.card = null;
    this.bubble.visible = !!this.model && !this.quiz;
  }

  private openFact() {
    if (!this.model) return;
    const info = factFor(this.model.name, this.model.url);
    this.card = makeFactCard({ title: this.model.name || info.title, fact: info.fact });
    this.raised.add(this.card);
    this.placeCard();
    this.bubble.visible = false;
  }

  // The raycaster must already be aimed. Tapping the protein opens the card; any tap closes it.
  private tapLearn() {
    if (!this.model) return;
    this.anchorGroup.updateMatrixWorld(true);
    // The screen and the pedestal work at any time, even while a question is open.
    if (this.tapConsole() || this.tapPedestal()) return;
    // While a question is open, taps only answer it: no fun-fact card or controls until it is answered.
    if (this.quiz) {
      this.tapQuiz();
      return;
    }
    if (this.card) {
      this.closeFact();
      return;
    }
    if (this.raycaster.intersectObjects([this.hitBox], false).length) this.openFact();
  }

  private onPointerUp(e: PointerEvent) {
    if (this.mode !== 'preview' || !this.pointerDown) return;
    const moved = Math.hypot(e.clientX - this.pointerDown.x, e.clientY - this.pointerDown.y);
    this.pointerDown = null;
    if (moved > 6) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(
      new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1),
      this.camera,
    );
    this.tapLearn();
  }

  // ----------------------------------------------------------------------------------------
  // Entering and leaving
  // ----------------------------------------------------------------------------------------

  /** Call straight from a tap handler: browsers only allow an AR session right after a user tap. */
  enterAR() {
    if (!this.model || this.session || this.mode === 'ar' || this.mode === 'preview') return;
    if (!navigator.xr) { this.enterPreview(); return; }
    navigator.xr
      .requestSession('immersive-ar', {
        requiredFeatures: ['hit-test'],
        optionalFeatures: ['local', 'dom-overlay', 'anchors', 'local-floor'],
        domOverlay: { root: this.overlay },
      })
      .then((session) => this.beginSession(session))
      .catch((e: unknown) => {
        this.events.error(`Could not start AR: ${e instanceof Error ? e.message : String(e)}`);
        this.enterPreview();
      });
  }

  enterPreview() {
    if (!this.model || this.mode === 'ar' || this.mode === 'preview') return;
    this.scene.background = this.previewBg;
    this.grid.visible = true;
    this.anchorGroup.matrix.identity();
    this.anchorGroup.visible = true;
    this.controls.enabled = true;
    this.consoleSnap = true;
    this.consoleWant = 1;
    this.setStatus('preview');
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.resize();
    const size = TARGET_SIZE;
    // Far enough back to see the whole pedestal, with its screen, and the protein on top.
    const mid = (this.pedestalH + size * 0.7) * 0.5;
    this.controls.target.set(0, mid, 0);
    this.camera.position.set(size * 1.5, mid + size * 0.6, size * 3.2);
    this.camera.near = 0.01;
    this.camera.far = 100;
    this.camera.updateProjectionMatrix();
    this.startLoop();
  }

  private async beginSession(session: XRSession) {
    try {
      this.renderer.xr.setReferenceSpaceType('local');
      this.renderer.xr.setFramebufferScaleFactor(1);
      this.renderer.xr.setFoveation(0);
      await this.renderer.xr.setSession(session);
      this.session = session;
      this.exiting = false;
      this.resScale = 1;
      this.recentDts.length = 0;
      this.resCeiling = 1;
      this.placedAt = 0;
      this.slowFrames = 0;
      this.fastFrames = 0;
      this.refSpace = this.renderer.xr.getReferenceSpace() as XRReferenceSpace;
      this.placed = false;
      this.locked = false;
      this.trackingLost = 0;
      this.scene.background = null;
      this.grid.visible = false;
      this.anchorGroup.visible = false;
      this.controls.enabled = false;
      this.setStatus('ar');

      const viewerSpace = await session.requestReferenceSpace('viewer');
      this.viewerSpace = viewerSpace;
      this.noHitSince = 0;
      this.hitTestRetried = false;
      this.manualPlaceReady = false;
      try {
        this.hitTestSource = (await session.requestHitTestSource?.({ space: viewerSpace, entityTypes: ['plane'] })) ?? null;
      } catch {
        this.hitTestSource = (await session.requestHitTestSource?.({ space: viewerSpace })) ?? null;
      }
      session.addEventListener('select', this.onSelect);
      session.addEventListener('end', this.onSessionEnd);
      this.events.hint('Point at the floor and move the phone slowly…');
      this.startLoop();
    } catch (e) {
      this.events.error(`AR failed to start: ${e instanceof Error ? e.message : String(e)}`);
      this.session = session;
      this.onSessionEnd();
      session.end().catch(() => undefined);
    }
  }

  exit() {
    if (this.session) {
      if (this.exiting) return;
      this.exiting = true;
      this.anchorGroup.visible = false; // keep the last AR frames cheap
      this.reticle.visible = false;
      const session = this.session;
      session.end().catch(() => this.onSessionEnd());
      // If the browser never fires 'end', clean up anyway so the UI cannot get stuck.
      setTimeout(() => { if (this.session === session) this.onSessionEnd(); }, 2000);
    } else if (this.mode === 'preview') {
      this.cleanupScene();
    }
  }

  private readonly onSessionEnd = () => {
    if (!this.session) return;
    const session = this.session;
    session.removeEventListener('select', this.onSelect);
    session.removeEventListener('end', this.onSessionEnd);
    try { this.hitTestSource?.cancel(); } catch { /* already gone */ }
    try { this.anchor?.delete(); } catch { /* already gone */ }
    this.session = null;
    this.hitTestSource = null;
    this.viewerSpace = null;
    this.anchor = null;
    this.lastHit = null;
    this.refSpace = null;
    this.exiting = false;
    this.cleanupScene();
  };

  private cleanupScene() {
    this.renderer.setAnimationLoop(null);
    this.clearFences();
    this.reticle.visible = false;
    this.anchorGroup.matrix.identity();
    this.anchorGroup.visible = true;
    this.scene.background = this.previewBg;
    this.grid.visible = true;
    this.placed = false;
    this.locked = false;
    this.consoleWant = 0;
    this.consoleOpen = 0;
    this.closeFact();
    this.clearChallenge();
    this.shrinkCanvas();
    this.events.hint('');
    this.events.dev([]);
    this.setStatus(this.model ? 'ready' : 'idle');
  }

  /** Keeps the light and its shadow frustum on the protein, and decides when the shadow map is redrawn. */
  private updateSun(t: number) {
    if (!this.model || this.shadowTier !== 'map') {
      this.renderer.shadowMap.needsUpdate = false;
      return;
    }
    const e = this.anchorGroup.matrix.elements;
    const sig = e[12] * 1.1 + e[13] * 1.3 + e[14] * 1.7 + e[0] * 2 + e[2] * 3;
    if (Math.abs(sig - this.lastAnchorSig) > 1e-4) {
      this.lastAnchorSig = sig;
      this.shadowDirty = true;
    }
    this.raised.getWorldPosition(this.tmpV);
    this.tmpV.y += (this.model.size.y * this.scale()) / 2;
    this.sun.target.position.copy(this.tmpV);
    this.sun.position.copy(this.tmpV).add(new THREE.Vector3(0.6, 1.6, 0.9).multiplyScalar(this.shadowRadius * 1.5));
    this.sun.target.updateMatrixWorld();
    // While the protein animates, refresh the shadow on every 3rd frame; otherwise only when something moved.
    const animating = this.animPlaying && !!this.model.mixer;
    const refresh = this.shadowDirty || (animating && this.frameCount % 3 === 0);
    this.renderer.shadowMap.needsUpdate = refresh;
    if (refresh) this.shadowDirty = false;
    void t;
  }

  private applyShadowTier() {
    const has = !!this.model;
    const mapShadows = this.shadowTier === 'map';
    this.shadowCatcher.visible = has && mapShadows;
    this.sun.castShadow = mapShadows;
    this.blob.visible = has && this.shadowTier === 'blob';
    this.shadowDirty = true;
  }

  /** Dev tool: step through shadow map, blob and off by hand. This also becomes the best tier auto may use. */
  cycleShadow(): ShadowTier {
    this.shadowTier = SHADOW_ORDER[(SHADOW_ORDER.indexOf(this.shadowTier) + 1) % SHADOW_ORDER.length];
    this.shadowCeiling = this.shadowTier;
    this.applyShadowTier();
    return this.shadowTier;
  }

  /** Dev tool: switch the below-floor hiding on and off. */
  toggleClip() {
    this.clipEnabled = !this.clipEnabled;
    this.floorOccluder.visible = this.clipEnabled;
    return this.clipEnabled;
  }

  /** Dev tool: unlock the protein so the next floor tap moves it. */
  toggleMove() {
    if (!this.session || !this.placed) return;
    this.locked = !this.locked;
    this.events.hint(this.locked ? '' : 'Aim at the floor and tap to move the protein');
  }

  // ----------------------------------------------------------------------------------------
  // XR frame logic
  // ----------------------------------------------------------------------------------------

  private readonly onSelect = (ev: XRInputSourceEvent) => {
    // Lifting fingers after a pinch must not count as a tap.
    if (performance.now() - this.pinchEndedAt < 400) return;
    if (this.locked) {
      if (!this.placed || !this.refSpace) return;
      const pose = ev.frame.getPose(ev.inputSource.targetRaySpace, this.refSpace);
      if (!pose) return;
      const { position: p, orientation: o } = pose.transform;
      this.raycaster.set(
        new THREE.Vector3(p.x, p.y, p.z),
        new THREE.Vector3(0, 0, -1).applyQuaternion(this.tmpQ.set(o.x, o.y, o.z, o.w)),
      );
      this.tapLearn();
      return;
    }
    if (!this.lastHit) {
      if (this.manualPlaceReady) this.placeInFront(ev.frame);
      return;
    }
    if (!this.hitHorizontal) { this.events.hint('That surface is not horizontal, aim at the floor'); return; }
    this.place(this.lastHit, this.lastHitMatrix);
  };

  /** Fallback when no floor is ever found: put the protein about 1.5 m ahead, at roughly floor height for a held phone. */
  private placeInFront(frame: XRFrame) {
    const pose = this.refSpace ? frame.getViewerPose(this.refSpace) : null;
    if (!pose) return;
    const { position: p, orientation: o } = pose.transform;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.tmpQ.set(o.x, o.y, o.z, o.w));
    forward.y = 0;
    if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1); // looking straight down: pick any direction
    forward.normalize().multiplyScalar(1.5);
    const matrix = new THREE.Matrix4().makeTranslation(p.x + forward.x, p.y - 1.3, p.z + forward.z);
    this.place(null, matrix);
  }

  /** Ask for more surface types (estimated planes and feature points) when plain plane hits never arrive. */
  private async reopenHitTest() {
    const session = this.session;
    const space = this.viewerSpace;
    if (!session || !space || !session.requestHitTestSource) return;
    try {
      const next = await session.requestHitTestSource({ space, entityTypes: ['plane', 'point'] });
      if (!next) return;
      if (this.session !== session) { next.cancel(); return; }
      try { this.hitTestSource?.cancel(); } catch { /* already gone */ }
      this.hitTestSource = next;
    } catch {
      /* this device only does plane hits: keep the current source */
    }
  }

  private place(hit: XRHitTestResult | null, hitMatrix: THREE.Matrix4) {
    const pos = new THREE.Vector3().setFromMatrixPosition(hitMatrix);
    // Rotate so the protein faces the viewer.
    const yaw = Math.atan2(this.viewerPos.x - pos.x, this.viewerPos.z - pos.z);
    const placeMatrix = new THREE.Matrix4().compose(pos, this.tmpQ.setFromAxisAngle(UP, yaw), new THREE.Vector3(1, 1, 1));
    this.anchorGroup.matrix.copy(placeMatrix);
    this.anchorGroup.matrixWorldNeedsUpdate = true;
    this.anchorGroup.visible = true;
    this.placed = true;
    this.locked = true;
    this.consoleSnap = true;
    this.consoleWant = 1;
    this.placedAt = performance.now();
    this.recentDts.length = 0;
    this.reticle.visible = false;

    try { this.anchor?.delete(); } catch { /* already gone */ }
    this.anchor = null;
    if (hit?.createAnchor) {
      // The anchor keeps the protein glued to the floor while ARCore refines its map.
      this.anchorOffset.copy(hitMatrix).invert().multiply(placeMatrix);
      hit.createAnchor().then((a) => { this.anchor = a; }).catch(() => undefined);
    }
    this.events.hint(this.quiz ? 'Placed! Tap an answer to catch it.' : 'Placed! Tap the protein to learn more. Pinch to resize.');
    setTimeout(() => { if (this.locked) this.events.hint(''); }, 4500);
  }

  private updateXR(frame: XRFrame) {
    const refSpace = this.refSpace;
    if (!refSpace) return;
    const viewerPose = frame.getViewerPose(refSpace);
    const tracking = !!viewerPose;
    if (tracking !== this.wasTracking) {
      if (!tracking) this.trackingLost++;
      this.wasTracking = tracking;
    }
    if (viewerPose) {
      const p = viewerPose.transform.position;
      const o = viewerPose.transform.orientation;
      this.viewerPos.set(p.x, p.y, p.z);
      // Count how often the tracked pose actually changes: camera and tracking often run at ~30 Hz.
      const cur = [p.x, p.y, p.z, o.x, o.y, o.z, o.w];
      if (!this.prevPose || cur.some((v, i) => Math.abs(v - this.prevPose![i]) > 1e-5)) this.poseChanges++;
      this.prevPose = cur;
      // Dynamic resolution: ask for a smaller viewport while frames are running late.
      for (const view of viewerPose.views) view.requestViewportScale?.(this.resScale);
    }

    if (this.hitTestSource && !this.locked) {
      const hits = frame.getHitTestResults(this.hitTestSource);
      const pose = hits[0]?.getPose(refSpace);
      if (hits.length && pose) {
        this.noHitSince = 0;
        this.manualPlaceReady = false;
        this.lastHit = hits[0];
        this.lastHitMatrix.fromArray(pose.transform.matrix);
        const o = pose.transform.orientation;
        this.tmpV.copy(UP).applyQuaternion(this.tmpQ.set(o.x, o.y, o.z, o.w));
        this.hitHorizontal = this.tmpV.y > 0.95;
        this.reticle.matrix.copy(this.lastHitMatrix);
        this.reticle.visible = true;
        (this.reticle.material as THREE.MeshBasicMaterial).color.set(this.hitHorizontal ? 0x4fd1a5 : 0xf2b84b);
        if (this.frameCount % 15 === 0) {
          this.events.hint(this.hitHorizontal ? 'Tap to place the protein' : 'Surface not horizontal, aim at the floor');
        }
      } else {
        this.lastHit = null;
        this.reticle.visible = false;
        const now = performance.now();
        if (!this.noHitSince) this.noHitSince = now;
        const waited = now - this.noHitSince;
        if (waited > 3000 && !this.hitTestRetried) {
          this.hitTestRetried = true;
          void this.reopenHitTest();
        }
        if (waited > 7000) this.manualPlaceReady = true;
        if (this.frameCount % 30 === 0) {
          this.events.hint(
            this.manualPlaceReady
              ? 'No floor found. Tap to place the protein in front of you'
              : 'Searching for floor… move the phone slowly',
          );
        }
      }
    }

    if (this.anchor && frame.trackedAnchors?.has(this.anchor)) {
      const ap = frame.getPose(this.anchor.anchorSpace, refSpace);
      if (ap) {
        this.anchorGroup.matrix.multiplyMatrices(this.tmpM.fromArray(ap.transform.matrix), this.anchorOffset);
        this.anchorGroup.matrixWorldNeedsUpdate = true;
      }
    }
    this.trackingText = tracking ? (viewerPose.emulatedPosition ? 'limited' : 'tracking') : 'LOST';
  }

  // ----------------------------------------------------------------------------------------
  // Render loop
  // ----------------------------------------------------------------------------------------

  private startLoop() {
    this.lastT = 0;
    this.dts.length = 0;
    this.statWindowStart = 0;
    this.renderer.setAnimationLoop(this.onFrame);
  }

  private readonly onFrame = (t: number, frame?: XRFrame) => {
    const dt = this.lastT ? t - this.lastT : 0;
    this.lastT = t;
    this.frameCount++;
    if (dt > 0) this.dts.push(dt);
    const cpuStart = performance.now();

    if (frame && this.session) this.updateXR(frame);
    else this.controls.update();
    if (this.animPlaying && this.model) {
      const step = Math.min(dt / 1000, 0.1);
      for (const mixer of this.model.mixers) mixer.update(step);
    }
    this.faceViewer();
    this.updateConsole(t, dt);
    if (this.quiz) this.tickQuiz();

    // The thought bubble bobs gently so it reads as something to tap.
    if (this.bubble.visible) this.bubble.position.y = this.bubbleBase + this.bubbleBob * Math.sin(t / 380);

    this.updateSun(t);

    if (this.devEnabled) this.gpuTimer?.begin();
    this.renderer.render(this.scene, this.camera);
    if (this.devEnabled) this.gpuTimer?.end();
    this.cpuMs = performance.now() - cpuStart;

    this.trackGpu();
    if (this.mode === 'ar' && this.autoRes && dt > 0) this.adaptResolution(dt);
    this.updateStats(t);
  };

  /**
   * Fences tell us when the GPU has really finished each frame. That gives the true output frame rate
   * and how many frames the GPU is behind (the backlog), which is what makes a heavy model feel laggy.
   */
  private trackGpu() {
    const gl = this.gl;
    const now = performance.now();
    while (this.fences.length) {
      const f = this.fences[0];
      const status = gl.clientWaitSync(f.sync, 0, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
        this.gpuLatency = now - f.t;
        this.gpuDone++;
        this.completions.push(now);
        gl.deleteSync(f.sync);
        this.fences.shift();
      } else if (status === gl.WAIT_FAILED) {
        gl.deleteSync(f.sync);
        this.fences.shift();
      } else break;
    }
    while (this.completions.length && this.completions[0] < now - 1000) this.completions.shift();
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (sync) {
      this.fences.push({ sync, t: now });
      if (this.fences.length > 30) gl.deleteSync(this.fences.shift()!.sync);
    }
    this.backlogAvg = this.backlogAvg * 0.85 + this.fences.length * 0.15;
  }

  private clearFences() {
    for (const f of this.fences) this.gl.deleteSync(f.sync);
    this.fences = [];
    this.backlogAvg = 0;
  }

  /**
   * Quality ladder with a fixed 60 fps target. It judges the MEDIAN frame time of the last ~30 frames, so a
   * one-off hitch (AR starting, a shader compiling, tracking recovering) never counts as "slow". While the
   * median is at 60 fps or better (about 57 allows for vsync jitter), quality stays at maximum. Below that it
   * gives up, in this order: shadow map -> blob shadow -> no shadow -> lower render resolution. Recovery goes
   * the other way, slowly. If raising something makes it slow again soon after, it is not tried again.
   * Nothing changes until the protein has been placed and has had a moment to settle.
   */
  private adaptResolution(dt: number) {
    const now = performance.now();
    if (!this.placed || now - this.placedAt < 2000) {
      this.recentDts.length = 0;
      this.slowFrames = 0;
      this.fastFrames = 0;
      return;
    }
    this.recentDts.push(dt);
    if (this.recentDts.length > 30) this.recentDts.shift();
    if (this.recentDts.length < 20) return;
    const sorted = [...this.recentDts].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    // Only slow if BOTH the frame callbacks and the frames the GPU actually finished are under ~57 fps.
    const outputFps = this.completions.length;
    const below = median > TARGET_MS * 1.05 && outputFps < 57;
    const comfortable = median < TARGET_MS * 1.03;
    this.slowFrames = below ? this.slowFrames + 1 : 0;
    this.fastFrames = comfortable ? this.fastFrames + 1 : 0;

    if (this.slowFrames >= 15) {
      this.slowFrames = 0;
      this.recentDts.length = 0; // measure the change on fresh frames
      this.lastChange = `down at median ${median.toFixed(1)} ms, ${outputFps} fps out`;
      const tier = SHADOW_ORDER.indexOf(this.shadowTier);
      if (tier < SHADOW_ORDER.length - 1) {
        this.shadowTier = SHADOW_ORDER[tier + 1];
        // Slow again right after an upgrade means that shadow type is too much for this phone.
        if (now - this.lastShadowUpgradeAt < 8000) this.shadowCeiling = this.shadowTier;
        this.applyShadowTier();
      } else if (this.resScale > 0.45) {
        this.resScale = Math.max(0.45, +(this.resScale - 0.1).toFixed(2));
        if (now - this.lastResUpgradeAt < 8000) this.resCeiling = this.resScale;
      }
    } else if (this.fastFrames >= 120) {
      this.fastFrames = 0;
      this.recentDts.length = 0;
      this.lastChange = `up at median ${median.toFixed(1)} ms`;
      if (this.resScale < this.resCeiling) {
        this.resScale = Math.min(this.resCeiling, +(this.resScale + 0.05).toFixed(2));
        this.lastResUpgradeAt = now;
      } else {
        const tier = SHADOW_ORDER.indexOf(this.shadowTier);
        if (tier > SHADOW_ORDER.indexOf(this.shadowCeiling)) {
          this.shadowTier = SHADOW_ORDER[tier - 1];
          this.lastShadowUpgradeAt = now;
          this.applyShadowTier();
        }
      }
    }
  }

  // Animation controls: a floating panel beside the protein, shown while the fun-fact card is open.
  playPause() {
    this.animPlaying = !this.animPlaying;
    this.shadowDirty = true;
    this.syncConsole();
  }

  restart() {
    for (const mixer of this.model?.mixers ?? []) mixer.setTime(0);
    this.animPlaying = true;
    this.shadowDirty = true;
    this.syncConsole();
  }

  setSpeed(speed: number) {
    this.animSpeed = speed;
    for (const mixer of this.model?.mixers ?? []) mixer.timeScale = speed;
    this.syncConsole();
  }

  /** Jump to a point in the animation, as a 0..1 fraction. */
  seek(fraction: number) {
    const m = this.model;
    if (!m?.mixer) return;
    for (const mixer of m.mixers) mixer.setTime(Math.min(1, Math.max(0, fraction)) * m.duration);
    this.shadowDirty = true;
    this.syncConsole();
  }

  /** The bubble and card are flat; turn them toward the viewer every frame. */
  private faceViewer() {
    const target = this.mode === 'ar' ? this.viewerPos : this.camera.position;
    if (this.bubble.visible) this.bubble.lookAt(target);
    this.card?.lookAt(target);
    this.quiz?.panel.mesh.lookAt(target);
  }

  // ----------------------------------------------------------------------------------------
  // Question panel: asked in the scene before the catch, then the usual bubble and controls appear
  // ----------------------------------------------------------------------------------------

  /**
   * Ask a question in the scene. `answer` sends the chosen option to the app and resolves with what it says.
   * Until it is answered right, the "tap to learn more" bubble, the fun-fact card and the animation panel stay away.
   * Pass null to remove it. Leaving AR or the 3D view always removes it.
   */
  setChallenge(challenge: Challenge | null, answer?: (index: number) => Promise<ChallengeOutcome>) {
    this.clearChallenge();
    if (!challenge || !answer || challenge.options.length < 2) return;
    this.closeFact();
    const panel = makeQuizPanel(challenge.question, challenge.options.slice(0, 4));
    this.raised.add(panel.mesh);
    this.quiz = { panel, answer, phase: 'asking', picked: -1, message: '', lockedUntil: 0, secondsLeft: 0 };
    this.events.challenge?.(true);
    this.layout();
  }

  private clearChallenge() {
    const q = this.quiz;
    if (!q) return;
    this.quiz = null;
    disposeSprite(q.panel.mesh);
    this.events.challenge?.(false);
    this.layout();
  }

  private placeQuiz() {
    const q = this.quiz;
    const m = this.model;
    if (!q || !m) return;
    const s = this.scale();
    const unit = Math.max(m.size.x, m.size.y, m.size.z) * s;
    const width = unit * 0.5;
    q.panel.mesh.scale.set(width, width / q.panel.mesh.userData.aspect, 1);
    q.panel.mesh.position.set(0, m.size.y * s + unit * 0.06, 0);
  }

  // ----------------------------------------------------------------------------------------
  // Pedestal and its control screen
  // ----------------------------------------------------------------------------------------

  /** The app says which styles this protein comes in, which one is showing, and what to do when one is picked. */
  setStyleToggle(options: StyleChoice[], active: StyleChoice | null, busy: boolean, pick: (style: StyleChoice) => void) {
    const ordered = (['ribbon', 'sphere'] as StyleChoice[]).filter((style) => options.includes(style));
    this.styleControl = ordered.length >= 2 && active ? { options: ordered, active, busy, pick } : null;
    this.syncConsole();
  }

  /** What the screen shows right now: add a field here (and in pedestal.ts) to add a setting. */
  private consoleState(): ConsoleState {
    const m = this.model;
    const animated = !!m?.mixer && m.actions.length > 0;
    return {
      title: m?.name ?? '',
      styles: this.styleControl
        ? { options: this.styleControl.options, active: this.styleControl.active, busy: this.styleControl.busy }
        : null,
      height: m ? { value: this.pedestalH, min: this.pedestalMin, max: PEDESTAL_MAX } : null,
      animation:
        animated && m
          ? {
              playing: this.animPlaying,
              speed: this.animSpeed,
              seconds: m.actions[0].time % (m.duration || 1),
              duration: m.duration,
            }
          : null,
    };
  }

  /** Repaint the screen; if its shape changed (a section came or went), fit the pedestal to it again. */
  private syncConsole() {
    if (this.pedestal.setState(this.consoleState())) this.layout();
  }

  private runConsole(action: ConsoleAction) {
    switch (action.type) {
      case 'style': {
        const control = this.styleControl;
        if (control && !control.busy && control.active !== action.style && control.options.includes(action.style)) {
          control.pick(action.style);
        }
        break;
      }
      case 'play':
        this.playPause();
        break;
      case 'restart':
        this.restart();
        break;
      case 'speed':
        this.setSpeed(action.speed);
        break;
      case 'seek':
        this.seek(action.fraction);
        break;
      case 'height':
        this.pedestalPref = action.value;
        try {
          localStorage.setItem(HEIGHT_KEY, String(action.value));
        } catch { /* storage unavailable: it just will not be remembered */ }
        this.layout();
        this.shadowDirty = true;
        break;
    }
  }

  /** The raycaster must already be aimed. True when the tap was on the screen. */
  private tapConsole() {
    if (this.consoleOpen < 0.9) return false;
    const hit = this.raycaster.intersectObject(this.pedestal.screen, false)[0];
    if (!hit?.uv) return false;
    const action = this.pedestal.hit(hit.uv.x, 1 - hit.uv.y);
    if (action) this.runConsole(action);
    return true;
  }

  /** Tapping the pedestal slides the screen away, or back out. */
  private tapPedestal() {
    if (!this.pedestal.hasContent) return false;
    const onPedestal = this.raycaster.intersectObject(this.pedestal.body, false)[0];
    if (!onPedestal) return false;
    // The protein stands on the pedestal: a tap that lands on the protein is for the protein.
    const onProtein = this.raycaster.intersectObject(this.hitBox, false)[0];
    if (onProtein && onProtein.distance < onPedestal.distance) return false;
    this.consoleWant = this.consoleWant ? 0 : 1;
    return true;
  }

  /** Turns the screen toward the viewer, slides it in and out, and keeps its playhead moving. */
  private updateConsole(t: number, dt: number) {
    if (!this.model) return;
    const target = this.mode === 'ar' ? this.viewerPos : this.camera.position;
    const local = this.tmpV.copy(target);
    this.anchorGroup.worldToLocal(local);
    local.y = 0;
    const away = local.length();
    if (away > 0.05) {
      local.divideScalar(away);
      if (this.consoleSnap) {
        this.consoleDir.copy(local);
        this.consoleSnap = false;
      } else {
        this.consoleDir.lerp(local, 1 - Math.exp(-dt / 160));
        if (this.consoleDir.lengthSq() < 1e-6) this.consoleDir.copy(local);
        this.consoleDir.normalize();
      }
    }
    const want = this.consoleWant && this.pedestal.hasContent ? 1 : 0;
    this.consoleOpen += (want - this.consoleOpen) * (1 - Math.exp(-dt / 170));
    if (Math.abs(want - this.consoleOpen) < 0.002) this.consoleOpen = want;
    this.pedestal.aim(Math.atan2(this.consoleDir.x, this.consoleDir.z), this.consoleOpen);
    if (this.consoleOpen > 0.5 && this.model.mixer && t - this.consoleDrawn > 120) {
      this.consoleDrawn = t;
      this.syncConsole();
    }
  }

  private drawQuiz() {
    const q = this.quiz;
    if (!q) return;
    q.panel.draw({ phase: q.phase, picked: q.picked, message: q.message, secondsLeft: q.secondsLeft });
  }

  /** The raycaster must already be aimed. */
  private tapQuiz() {
    const q = this.quiz;
    if (!q || !q.panel.mesh.parent) return;
    const hit = this.raycaster.intersectObject(q.panel.mesh, false)[0];
    if (!hit?.uv) return;
    const index = q.panel.hit(hit.uv.x, 1 - hit.uv.y);
    if (index >= 0) this.submitAnswer(index);
  }

  private submitAnswer(index: number) {
    const q = this.quiz;
    if (!q || q.phase === 'checking' || q.phase === 'correct') return;
    if (q.phase === 'wrong' && performance.now() < q.lockedUntil) return;
    q.phase = 'checking';
    q.picked = index;
    q.message = '';
    q.secondsLeft = 0;
    this.drawQuiz();
    q.answer(index)
      .catch((): ChallengeOutcome => ({ ok: false, message: 'Could not check that answer.', retryAfterMs: 3000 }))
      .then((outcome) => {
        if (this.quiz !== q) return; // closed while waiting
        if (outcome.ok) {
          q.phase = 'correct';
          q.message = outcome.message ?? 'Correct!';
          this.drawQuiz();
          // A moment to read the result, then the protein's usual bubble and controls take over.
          setTimeout(() => {
            if (this.quiz !== q) return;
            this.clearChallenge();
            this.events.hint('Caught! Tap the protein to learn more.');
            setTimeout(() => { if (!this.quiz) this.events.hint(''); }, 4500);
          }, 1800);
        } else if (outcome.fatal) {
          this.events.error(outcome.message);
          this.exit();
        } else {
          const wait = outcome.retryAfterMs ?? 5000;
          q.phase = 'wrong';
          q.message = outcome.message;
          q.lockedUntil = performance.now() + wait;
          q.secondsLeft = Math.ceil(wait / 1000);
          this.drawQuiz();
        }
      });
  }

  /** Counts the wrong-answer wait down on the panel, then lets the options be tapped again. */
  private tickQuiz() {
    const q = this.quiz;
    if (!q || q.phase !== 'wrong') return;
    const secs = Math.max(0, Math.ceil((q.lockedUntil - performance.now()) / 1000));
    if (secs === q.secondsLeft) return;
    q.secondsLeft = secs;
    if (secs === 0) {
      q.phase = 'asking';
      q.picked = -1;
      q.message = '';
    }
    this.drawQuiz();
  }

  /** Two-finger pinch on `el` resizes the protein. */
  bindPinch(el: HTMLElement) {
    const pointers = new Map<number, { x: number; y: number }>();
    let startDist = 0;
    let startScale = 1;
    const dist = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    el.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        startDist = dist();
        startScale = this.userScale;
        this.pinchEndedAt = performance.now() + 1e9; // a pinch is in progress: no taps
      }
    });
    el.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size !== 2 || startDist < 10) return;
      this.userScale = Math.min(MAX_USER_SCALE, Math.max(MIN_USER_SCALE, startScale * (dist() / startDist)));
      this.layout();
    });
    const end = (e: PointerEvent) => {
      if (pointers.size >= 2) this.pinchEndedAt = performance.now();
      pointers.delete(e.pointerId);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  /** Dev tool: dynamic resolution on/off. Returns the new state. */
  toggleAutoRes() {
    this.autoRes = !this.autoRes;
    if (!this.autoRes) this.resScale = 1;
    return this.autoRes;
  }

  /** Stats only cost React renders while the dev panel is open. */
  setDevEnabled(on: boolean) {
    this.devEnabled = on;
  }

  private cpuMs = 0;

  private updateStats(t: number) {
    if (!this.devEnabled) { this.dts.length = 0; this.poseChanges = 0; return; }
    if (!this.statWindowStart) this.statWindowStart = t;
    const elapsed = t - this.statWindowStart;
    if (elapsed < 1000) return;

    const dts = [...this.dts].sort((a, b) => a - b);
    const n = dts.length;
    const avg = n ? dts.reduce((x, y) => x + y, 0) / n : 0;
    const p95 = n ? dts[Math.min(n - 1, Math.floor(n * 0.95))] : 0;
    const max = n ? dts[n - 1] : 0;
    const worst = dts.slice(Math.max(0, n - Math.max(1, Math.ceil(n * 0.01))));
    const low1 = worst.length ? 1000 / (worst.reduce((x, y) => x + y, 0) / worst.length) : 0;
    const fps = avg ? 1000 / avg : 0;
    const poseHz = (this.poseChanges * 1000) / elapsed;
    const gpuFps = (this.gpuDone * 1000) / elapsed;
    this.gpuDone = 0;
    this.dts.length = 0;
    this.poseChanges = 0;
    this.statWindowStart = t;

    const info = this.renderer.info.render;
    const gpu = this.gpuTimer?.supported ? (this.gpuTimer.lastMs != null ? `${this.gpuTimer.lastMs.toFixed(1)} ms` : '...') : 'n/a';
    const lines = [
      `build ${__BUILD__}`,
      `${gpuFps.toFixed(0)} fps shown  (callbacks ${fps.toFixed(0)}, 1% low ${low1.toFixed(0)})`,
      `gpu behind by ${this.fences.length} frames  (${this.gpuLatency.toFixed(0)} ms latency)`,
      `frame ${avg.toFixed(1)} ms  p95 ${p95.toFixed(1)}  max ${max.toFixed(0)}`,
      `cpu ${this.cpuMs.toFixed(1)} ms  gpu ${gpu}`,
      `${info.triangles.toLocaleString()} tris · ${info.calls} draws`,
      this.model ? `detail ${this.lodLevel === 0 ? 'full' : 'low'}${this.model.low && !this.model.high ? ' (full loading)' : ''}` : 'detail -',
    ];
    if (this.mode === 'ar') {
      lines.push(`tracking updates ${poseHz.toFixed(0)}/s`);
      const vp = (this.renderer.xr.getCamera().cameras[0] as THREE.PerspectiveCamera & { viewport?: THREE.Vector4 } | undefined)?.viewport;
      const canScale = typeof XRView !== 'undefined' && 'requestViewportScale' in XRView.prototype;
      lines.push(`shadow ${this.shadowTier}${this.autoRes ? ' (auto)' : ''}`);
      lines.push(`last auto change: ${this.lastChange}`);
      lines.push(`res ${(this.resScale * 100).toFixed(0)}%${this.autoRes ? ' (auto)' : ''} · viewport ${vp ? `${vp.z}x${vp.w}` : '?'}${canScale ? '' : ' · scaling unsupported'}`);
      if (this.modelCounts) lines.push(`model ${(this.modelCounts.vertices / 1e6).toFixed(2)}M verts`);
      lines.push(`tracking ${this.trackingText} (lost ${this.trackingLost}x)`);
      if (this.placed) lines.push(`distance ${this.viewerPos.distanceTo(this.tmpV.setFromMatrixPosition(this.anchorGroup.matrix)).toFixed(2)} m`);
    }
    this.fpsText = lines;
    this.events.dev(lines);
  }

  /**
   * Keep the page canvas tiny whenever it is not being shown. When an AR session ends, three.js restores
   * the canvas to the size it had when the session began; a full-screen 2x canvas there is a large
   * allocation right as the phone tears down the camera buffers, and can crash the tab.
   */
  private shrinkCanvas() {
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(2, 2, false);
  }

  private resize() {
    if (this.mode !== 'preview' || this.renderer.xr.isPresenting) return;
    const w = this.container.clientWidth || innerWidth;
    const h = this.container.clientHeight || innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  private setStatus(status: ViewerStatus) {
    this.mode = status;
    this.events.status(status);
  }

  dispose() {
    removeEventListener('resize', this.onResize);
    this.pedestal.dispose();
    this.renderer.setAnimationLoop(null);
    this.unload();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
