import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PerfMonitor, fmtBytes, fmtNum } from './stats.js';

const THREE_JSM = 'https://cdn.jsdelivr.net/npm/three@0.187.0/examples/jsm/';
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Renderer, scene, preview camera
// ---------------------------------------------------------------------------

const antialias = params.get('aa') === '1';
const renderer = new THREE.WebGLRenderer({ antialias, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.xr.enabled = true;
document.body.prepend(renderer.domElement);

const perf = new PerfMonitor({ hud: $('hud'), hudWrap: $('hudWrap'), graph: $('graph'), log: $('log'), renderer });

const scene = new THREE.Scene();
const previewBg = new THREE.Color(0x1b1f25);
scene.background = previewBg;

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.01, 200);
camera.position.set(1.4, 1.1, 1.8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.45, 0);
controls.enableDamping = true;

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.9;

const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);

const grid = new THREE.GridHelper(4, 16, 0x3a424d, 0x2a3038);
scene.add(grid);

// Placement hierarchy: anchorGroup (pose from hit-test / anchor) -> content (user yaw + scale) -> instances
const anchorGroup = new THREE.Group();
anchorGroup.matrixAutoUpdate = false;
scene.add(anchorGroup);
const content = new THREE.Group();
anchorGroup.add(content);

const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.07, 0.09, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x4fd1a5, transparent: true, opacity: 0.9, depthTest: false }),
);
reticle.add(new THREE.Mesh(
  new THREE.CircleGeometry(0.012, 16).rotateX(-Math.PI / 2),
  reticle.material,
));
reticle.matrixAutoUpdate = false;
reticle.visible = false;
reticle.renderOrder = 10;
scene.add(reticle);

// Soft blob shadow texture (cheap contact shadow, one quad per instance).
const blobTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,0.55)');
  grd.addColorStop(0.6, 'rgba(0,0,0,0.25)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
const blobMat = new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
const shadowCatcher = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
  new THREE.ShadowMaterial({ opacity: 0.35 }),
);
shadowCatcher.receiveShadow = true;
shadowCatcher.visible = false;
content.add(shadowCatcher);

// ---------------------------------------------------------------------------
// Loaders (Draco, Meshopt, KTX2 all wired so any optimized GLB works)
// ---------------------------------------------------------------------------

const loader = new GLTFLoader();
loader.setDRACOLoader(new DRACOLoader().setDecoderPath(`${THREE_JSM}libs/draco/gltf/`));
loader.setKTX2Loader(new KTX2Loader().setTranscoderPath(`${THREE_JSM}libs/basis/`).detectSupport(renderer));
loader.setMeshoptDecoder(MeshoptDecoder);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  mode: 'menu', // menu | preview | ar
  model: null, // { name, template, clips, size, footprint, stats }
  instances: [], // { root, mixer, blob }
  clones: 1,
  targetSize: 1.0, // metres, largest dimension
  realScale: false,
  yaw: 0,
  animate: true,
  shadowMode: 'blob', // blob | map | off
  matMode: 'original', // original | lambert | unlit | normals
  // XR
  session: null,
  refSpace: null,
  hitTestSource: null,
  lastHit: null,
  lastHitMatrix: new THREE.Matrix4(),
  hitHorizontal: false,
  placed: false,
  locked: false,
  anchor: null,
  anchorOffset: new THREE.Matrix4(),
  anchorLastPos: new THREE.Vector3(),
  anchorCorrections: 0,
  viewerPos: new THREE.Vector3(),
  trackingLost: 0,
  wasTracking: true,
  frameCount: 0,
};

const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const timer = new THREE.Timer();
// Mesh -> its glTF material. Kept outside userData because Object3D.clone() JSON-copies userData.
const origMat = new WeakMap();

// ---------------------------------------------------------------------------
// Device info
// ---------------------------------------------------------------------------

{
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  perf.set('Device', {
    gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    dpr: devicePixelRatio.toFixed(2),
    screen: `${screen.width}×${screen.height}`,
    cores: navigator.hardwareConcurrency ?? 'n/a',
    ram: navigator.deviceMemory ? `${navigator.deviceMemory} GB` : 'n/a',
    maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    msaa: antialias ? 'on' : 'off',
    gpuTimer: perf.gpu.ext ? 'yes' : 'no',
  });
  perf.log(`Renderer: ${perf.sections.get('Device').gpu}`);
}

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = +(res.headers.get('X-Decoded-Length') || (res.headers.get('Content-Encoding') ? 0 : res.headers.get('Content-Length')) || 0);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  let out = total ? new Uint8Array(total) : null;
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (out && received + value.length <= out.length) out.set(value, received);
    else { if (out) { chunks.push(out.subarray(0, received)); out = null; } chunks.push(value); }
    received += value.length;
    onProgress(received, total);
  }
  if (out) return out.subarray(0, received);
  const buf = new Uint8Array(received);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.length; }
  return buf;
}

function analyze(root) {
  let meshes = 0, vertices = 0, triangles = 0, geoBytes = 0, texBytes = 0;
  const geos = new Set(), mats = new Set(), texs = new Set(), arrays = new Set();
  root.traverse((o) => {
    if (!o.isMesh && !o.isPoints && !o.isLine) return;
    meshes++;
    const g = o.geometry;
    vertices += g.attributes.position.count;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    if (!geos.has(g)) {
      geos.add(g);
      for (const a of [...Object.values(g.attributes), g.index].filter(Boolean)) {
        const arr = a.isInterleavedBufferAttribute ? a.data.array : a.array;
        if (!arrays.has(arr)) { arrays.add(arr); geoBytes += arr.byteLength; }
      }
    }
    for (const m of [].concat(o.material)) {
      mats.add(m);
      for (const v of Object.values(m)) if (v && v.isTexture) texs.add(v);
    }
  });
  for (const t of texs) {
    if (t.isCompressedTexture) texBytes += t.mipmaps.reduce((s, m) => s + m.data.byteLength, 0);
    else if (t.image?.width) texBytes += t.image.width * t.image.height * 4 * (t.generateMipmaps ? 1.33 : 1);
  }
  return { meshes, geometries: geos.size, materials: mats.size, textures: texs.size, vertices, triangles, geoBytes, texBytes };
}

function disposeModel() {
  removeInstances();
  if (!state.model) return;
  state.model.template.traverse((o) => {
    if (!o.isMesh) return;
    o.geometry.dispose();
    for (const m of [].concat(origMat.get(o) || o.material)) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
  for (const byMode of state.model.variants.values()) for (const m of Object.values(byMode)) m.dispose();
  state.model = null;
}

async function loadModel(src) {
  const name = src.name || src.url;
  $('enterAR').disabled = true;
  $('loadBar').firstElementChild.style.width = '0%';
  const status = (s) => { $('loadStatus').textContent = s; };
  status(`Loading ${name}…`);
  perf.log(`Loading ${name}`);
  disposeModel();
  perf.clear('Model');
  perf.clear('Load');

  try {
    const t0 = performance.now();
    let bytes, transfer = null;
    if (src.file) {
      bytes = new Uint8Array(await src.file.arrayBuffer());
    } else {
      bytes = await fetchWithProgress(src.url, (got, total) => {
        if (total) $('loadBar').firstElementChild.style.width = `${Math.min(100, (got / total) * 100)}%`;
        status(`Downloading ${name}… ${fmtBytes(got)}${total ? ` / ${fmtBytes(total)}` : ''}`);
      });
      const rt = performance.getEntriesByName(new URL(src.url, location.href).href).pop();
      if (rt) transfer = rt.transferSize || rt.encodedBodySize || null;
    }
    const t1 = performance.now();
    status(`Parsing / decoding ${fmtBytes(bytes.byteLength)}…`);
    const base = src.url ? src.url.slice(0, src.url.lastIndexOf('/') + 1) : '';
    // Avoid a second copy of the file when the view already spans its whole buffer (matters for GB-sized models).
    const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    const gltf = await loader.parseAsync(whole ? bytes.buffer : bytes.slice().buffer, base);
    const t2 = performance.now();

    const template = gltf.scene;
    template.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(template);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    template.position.set(-center.x, -box.min.y, -center.z); // bottom-centre at origin
    template.traverse((o) => { if (o.isMesh) origMat.set(o, o.material); });

    const stats = analyze(template);
    state.model = { name, template, variants: new Map(), clips: gltf.animations, size, footprint: Math.max(size.x, size.z), stats };
    rebuildInstances();
    applyMaterialMode();
    applyShadowMode();

    status('Compiling shaders…');
    const t3 = performance.now();
    await renderer.compileAsync(scene, camera);
    const t4 = performance.now();

    const ext = gltf.parser.json.extensionsUsed || [];
    perf.set('Model', {
      name,
      verts: fmtNum(stats.vertices),
      tris: fmtNum(stats.triangles),
      meshes: `${stats.meshes} (draw calls/copy)`,
      materials: stats.materials,
      textures: `${stats.textures} (${fmtBytes(stats.texBytes)})`,
      'geom mem': fmtBytes(stats.geoBytes),
      size: `${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)} units`,
      anims: gltf.animations.length ? gltf.animations.map((a) => `${a.name} ${a.duration.toFixed(1)}s`).join(', ') : 'none',
      ext: ext.length ? ext.join(', ') : 'none',
    });
    perf.set('Load', {
      file: fmtBytes(bytes.byteLength),
      transfer: transfer ? fmtBytes(transfer) : (src.file ? 'local file' : 'n/a (cached?)'),
      download: `${(t1 - t0).toFixed(0)} ms`,
      'parse+decode': `${(t2 - t1).toFixed(0)} ms`,
      compile: `${(t4 - t3).toFixed(0)} ms`,
      total: `${(t4 - t0).toFixed(0)} ms`,
    });
    updateScaleInfo();
    $('loadBar').firstElementChild.style.width = '100%';
    status(
      `${name}\n${fmtBytes(bytes.byteLength)} · ${fmtNum(stats.vertices)} verts · ${fmtNum(stats.triangles)} tris · ${stats.meshes} meshes\n` +
      `download ${(t1 - t0).toFixed(0)} ms · decode ${(t2 - t1).toFixed(0)} ms · compile ${(t4 - t3).toFixed(0)} ms`,
    );
    perf.log(`Loaded ${name}: ${fmtBytes(bytes.byteLength)}, ${fmtNum(stats.triangles)} tris, geom ${fmtBytes(stats.geoBytes)}, ` +
      `download ${(t1 - t0).toFixed(0)} ms, decode ${(t2 - t1).toFixed(0)} ms, compile ${(t4 - t3).toFixed(0)} ms [${ext.join(', ') || 'no ext'}]`);
    $('enterAR').disabled = !arSupported;
  } catch (e) {
    status(`Failed to load ${name}:\n${e.message}`);
    perf.log(`Load failed: ${e.stack || e.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Instances (copies for stress testing), scale, shadows, material modes
// ---------------------------------------------------------------------------

function removeInstances() {
  for (const inst of state.instances) {
    inst.mixer?.stopAllAction();
    inst.blob.geometry.dispose();
    content.remove(inst.root);
  }
  state.instances = [];
}

function cloneModel(template) {
  const copy = template.clone();
  const src = [], dst = [];
  template.traverse((o) => src.push(o));
  copy.traverse((o) => dst.push(o));
  src.forEach((o, i) => { if (origMat.has(o)) origMat.set(dst[i], origMat.get(o)); });
  return copy;
}

function rebuildInstances() {
  removeInstances();
  const m = state.model;
  if (!m) return;

  const n = state.clones;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const spacing = m.footprint * 1.15;
  for (let i = 0; i < n; i++) {
    const root = new THREE.Group();
    const model = i === 0 ? m.template : cloneModel(m.template); // clones share geometry + materials
    root.add(model);
    const blob = new THREE.Mesh(new THREE.PlaneGeometry(m.footprint * 1.4, m.footprint * 1.4).rotateX(-Math.PI / 2), blobMat);
    blob.position.y = 0.001;
    root.add(blob);
    root.position.set(((i % cols) - (cols - 1) / 2) * spacing, 0, (Math.floor(i / cols) - (rows - 1) / 2) * spacing);
    let mixer = null;
    if (m.clips.length) {
      mixer = new THREE.AnimationMixer(model);
      for (const clip of m.clips) mixer.clipAction(clip).play();
    }
    content.add(root);
    state.instances.push({ root, mixer, blob });
  }
  const extent = Math.max(cols, rows) * spacing;
  shadowCatcher.scale.set(extent * 1.5, 1, extent * 1.5);
  applyShadowMode();
  updateScaleInfo();
  perf.set('Scene', { copies: n });
}

function contentScale() {
  if (!state.model) return 1;
  return state.realScale ? 1 : state.targetSize / Math.max(state.model.size.x, state.model.size.y, state.model.size.z);
}

function updateScaleInfo() {
  const s = contentScale();
  content.scale.setScalar(s);
  content.rotation.y = state.yaw;
  if (!state.model) return;
  const sz = state.model.size.clone().multiplyScalar(s);
  perf.set('Scene', {
    copies: state.clones,
    'world size': `${sz.x.toFixed(2)}×${sz.y.toFixed(2)}×${sz.z.toFixed(2)} m`,
    scale: state.realScale ? '1:1 (file units = m)' : s.toFixed(4),
    material: state.matMode,
    shadow: state.shadowMode,
    anim: state.model.clips.length ? (state.animate ? 'playing' : 'paused') : 'none',
  });
  if (state.mode === 'preview' || state.mode === 'menu') frameCameraToContent();
}

function frameCameraToContent() {
  if (!state.model) return;
  const s = contentScale();
  const h = state.model.size.y * s;
  const r = Math.max(state.model.size.x, state.model.size.y, state.model.size.z) * s * Math.max(1, Math.sqrt(state.clones));
  controls.target.set(0, h / 2, 0);
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(controls.target).addScaledVector(dir, r * 1.8 + 0.2);
  camera.near = Math.max(0.005, r / 200);
  camera.far = r * 50 + 10;
  camera.updateProjectionMatrix();
}

function applyShadowMode() {
  const mode = state.shadowMode;
  for (const inst of state.instances) inst.blob.visible = mode === 'blob';
  const useMap = mode === 'map';
  shadowCatcher.visible = useMap;
  if (renderer.shadowMap.enabled !== useMap || sun.castShadow !== useMap) {
    renderer.shadowMap.enabled = useMap;
    sun.castShadow = useMap;
    content.traverse((o) => {
      if (!o.isMesh) return;
      if (o !== shadowCatcher && !state.instances.some((i) => i.blob === o)) o.castShadow = useMap;
      for (const m of [].concat(o.material)) m.needsUpdate = true; // shadow map toggles need a shader recompile
    });
  }
}

function makeVariant(orig, mode) {
  const common = { vertexColors: orig.vertexColors, side: orig.side };
  switch (mode) {
    case 'lambert': return new THREE.MeshLambertMaterial({ ...common, color: orig.color, map: orig.map });
    case 'unlit': return new THREE.MeshBasicMaterial({ ...common, color: orig.color, map: orig.map });
    case 'normals': return new THREE.MeshNormalMaterial({ side: orig.side });
    default: return orig;
  }
}

function applyMaterialMode() {
  if (!state.model) return;
  const mode = state.matMode;
  // Variants are cached per original material and shared by every copy.
  const variants = state.model.variants;
  const pick = (orig) => {
    if (mode === 'original') return orig;
    if (!variants.has(orig)) variants.set(orig, {});
    const byMode = variants.get(orig);
    return (byMode[mode] ||= makeVariant(orig, mode));
  };
  for (const inst of state.instances) {
    inst.root.traverse((o) => {
      const orig = o.isMesh && origMat.get(o);
      if (orig) o.material = Array.isArray(orig) ? orig.map(pick) : pick(orig);
    });
  }
  updateScaleInfo();
}

function updateSun() {
  // Keep the directional light + its shadow frustum wrapped around the content, wherever it is placed.
  const s = contentScale();
  const cols = Math.ceil(Math.sqrt(state.clones));
  const R = (state.model ? Math.max(state.model.footprint * 1.15 * cols, state.model.size.y) : 1) * s * 0.75 + 0.1;
  anchorGroup.getWorldPosition(tmpV);
  sun.target.position.copy(tmpV);
  sun.position.copy(tmpV).add(new THREE.Vector3(0.6, 1.6, 0.9).multiplyScalar(R * 1.5));
  sun.target.updateMatrixWorld();
  if (sun.castShadow) {
    const c = sun.shadow.camera;
    c.left = c.bottom = -R;
    c.right = c.top = R;
    c.near = 0.01;
    c.far = R * 6;
    c.updateProjectionMatrix();
  }
}

// ---------------------------------------------------------------------------
// WebXR AR session
// ---------------------------------------------------------------------------

let arSupported = false;

async function checkXR() {
  const el = $('xrSupport');
  if (!window.isSecureContext) {
    el.textContent = 'Not a secure context: WebXR needs HTTPS (or localhost via USB port forwarding).';
    return;
  }
  if (!navigator.xr) {
    el.textContent = 'navigator.xr missing: this browser has no WebXR. Use Chrome on an ARCore Android phone. (iOS Safari does not expose WebXR AR.)';
    return;
  }
  try { arSupported = await navigator.xr.isSessionSupported('immersive-ar'); } catch { arSupported = false; }
  el.textContent = arSupported ? 'immersive-ar supported ✓' : 'immersive-ar NOT supported on this device/browser. Preview mode still works.';
  perf.log(`immersive-ar supported: ${arSupported}`);
  if (state.model) $('enterAR').disabled = !arSupported;
}

async function startAR() {
  if (!state.model) return;
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'anchors', 'local-floor'],
      domOverlay: { root: $('overlay') },
    });
  } catch (e) {
    perf.log(`requestSession failed: ${e.message}`, 'error');
    alert(`Could not start AR: ${e.message}`);
    return;
  }

  const fbSel = $('fbScale').value;
  const fbScale = fbSel === 'native' ? XRWebGLLayer.getNativeFramebufferScaleFactor(session) : parseFloat(fbSel);
  const foveation = parseFloat($('foveation').value);
  renderer.xr.setReferenceSpaceType('local');
  renderer.xr.setFramebufferScaleFactor(fbScale);
  renderer.xr.setFoveation(foveation);
  await renderer.xr.setSession(session);

  state.session = session;
  state.refSpace = renderer.xr.getReferenceSpace();
  state.placed = false;
  state.locked = false;
  state.trackingLost = 0;
  state.anchorCorrections = 0;
  setMode('ar');
  perf.resetTiming();

  scene.background = null;
  grid.visible = false;
  anchorGroup.visible = false;
  controls.enabled = false;

  const viewerSpace = await session.requestReferenceSpace('viewer');
  try {
    state.hitTestSource = await session.requestHitTestSource({ space: viewerSpace, entityTypes: ['plane'] });
  } catch {
    state.hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
    perf.log('hit-test: entityTypes unsupported, using default', 'warn');
  }

  session.addEventListener('select', onSelect);
  session.addEventListener('end', onSessionEnd);
  session.addEventListener('visibilitychange', () => perf.log(`XR visibility: ${session.visibilityState}`));

  // Taps on overlay UI must not also place the model.
  for (const el of document.querySelectorAll('#overlay .ui')) {
    el.addEventListener('beforexrselect', (ev) => ev.preventDefault());
  }

  const layer = renderer.xr.getBaseLayer();
  const fbW = layer.framebufferWidth ?? layer.textureWidth;
  const fbH = layer.framebufferHeight ?? layer.textureHeight;
  const feats = session.enabledFeatures ? [...session.enabledFeatures].join(', ') : 'n/a';
  perf.set('XR', {
    framebuffer: `${fbW}×${fbH} (${(fbW * fbH / 1e6).toFixed(2)} MP)`,
    'fb scale': `${fbScale.toFixed(2)}${fbSel === 'native' ? ' (native)' : ''}`,
    foveation,
    blend: session.environmentBlendMode ?? 'n/a',
    overlay: session.domOverlayState?.type ?? 'none',
    features: feats,
    'frame rate': session.frameRate ? `${session.frameRate} Hz` : 'browser default',
  });
  perf.log(`AR session started: fb ${fbW}×${fbH} @ scale ${fbScale.toFixed(2)}, features [${feats}], overlay ${session.domOverlayState?.type ?? 'none'}`);

  if (session.supportedFrameRates?.length) {
    $('btnFps').classList.remove('hidden');
    perf.log(`Supported frame rates: ${[...session.supportedFrameRates].join(', ')}`);
  }
  setHint('Point at the floor and move the phone slowly…');
}

function onSessionEnd() {
  perf.log(`AR session ended (tracking lost ${state.trackingLost}×, anchor corrections ${state.anchorCorrections})`);
  state.anchor?.delete?.();
  Object.assign(state, { session: null, hitTestSource: null, anchor: null, lastHit: null, placed: false });
  reticle.visible = false;
  anchorGroup.matrix.identity();
  anchorGroup.visible = true;
  scene.background = previewBg;
  grid.visible = true;
  controls.enabled = true;
  perf.targetHz = 60;
  perf.clear('XR');
  perf.clear('Tracking');
  $('btnFps').classList.add('hidden');
  perf.resetTiming();
  setHint('');
  setMode('menu');
  onResize();
  updateScaleInfo();
}

function onSelect() {
  if (state.locked || !state.lastHit) return;
  if (!state.hitHorizontal) { setHint('That surface isn’t horizontal, aim at the floor'); return; }
  place(state.lastHit, state.lastHitMatrix);
}

function place(hit, hitMatrix) {
  // Position from the hit, yaw rotated so the model's front faces the viewer.
  const pos = new THREE.Vector3().setFromMatrixPosition(hitMatrix);
  const yaw = Math.atan2(state.viewerPos.x - pos.x, state.viewerPos.z - pos.z);
  const placeMatrix = new THREE.Matrix4().compose(pos, tmpQ.setFromAxisAngle(UP, yaw), new THREE.Vector3(1, 1, 1));
  anchorGroup.matrix.copy(placeMatrix);
  anchorGroup.matrixWorldNeedsUpdate = true;
  anchorGroup.visible = true;
  state.placed = true;
  state.locked = true;
  state.anchorLastPos.copy(pos);
  reticle.visible = false;
  $('btnMove').classList.remove('on');

  state.anchor?.delete?.();
  state.anchor = null;
  if (hit.createAnchor) {
    // Anchor keeps the model glued to the floor while ARCore refines its map as you walk around.
    state.anchorOffset.copy(hitMatrix).invert().multiply(placeMatrix);
    hit.createAnchor().then((a) => {
      state.anchor = a;
      perf.log('Anchor created');
    }).catch((e) => perf.log(`Anchor failed: ${e.message}`, 'warn'));
  }
  const camHeight = state.viewerPos.y - pos.y;
  perf.log(`Placed at (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}), ${camHeight.toFixed(2)} m below camera`);
  setHint('Placed & locked. Walk around! (Move to reposition)');
  setTimeout(() => { if (state.locked) setHint(''); }, 3500);
}

function updateXR(frame) {
  const refSpace = state.refSpace;
  const viewerPose = frame.getViewerPose(refSpace);
  const tracking = !!viewerPose;
  if (tracking !== state.wasTracking) {
    if (!tracking) state.trackingLost++;
    perf.log(tracking ? 'Tracking restored' : 'Tracking LOST', tracking ? 'info' : 'warn');
    state.wasTracking = tracking;
  }
  if (viewerPose) {
    const p = viewerPose.transform.position;
    state.viewerPos.set(p.x, p.y, p.z);
  }

  // Hit test against detected planes.
  if (state.hitTestSource && !state.locked) {
    const hits = frame.getHitTestResults(state.hitTestSource);
    if (hits.length) {
      const pose = hits[0].getPose(refSpace);
      state.lastHit = hits[0];
      state.lastHitMatrix.fromArray(pose.transform.matrix);
      const o = pose.transform.orientation;
      tmpV.copy(UP).applyQuaternion(tmpQ.set(o.x, o.y, o.z, o.w));
      state.hitHorizontal = tmpV.y > 0.95;
      const below = state.viewerPos.y - pose.transform.position.y;
      reticle.matrix.copy(state.lastHitMatrix);
      reticle.visible = true;
      reticle.material.color.set(state.hitHorizontal ? 0x4fd1a5 : 0xf2b84b);
      if (state.frameCount % 15 === 0) {
        setHint(state.hitHorizontal
          ? `Tap to place · surface ${below.toFixed(2)} m below phone${below > 0.7 ? ' (floor)' : ''}`
          : 'Surface not horizontal, aim at the floor');
      }
    } else {
      state.lastHit = null;
      reticle.visible = false;
      if (state.frameCount % 30 === 0) setHint('Searching for floor… move the phone slowly');
    }
  }

  // Follow the anchor as tracking refines.
  if (state.anchor && frame.trackedAnchors?.has(state.anchor)) {
    const ap = frame.getPose(state.anchor.anchorSpace, refSpace);
    if (ap) {
      anchorGroup.matrix.multiplyMatrices(tmpM.fromArray(ap.transform.matrix), state.anchorOffset);
      anchorGroup.matrixWorldNeedsUpdate = true;
      tmpV.setFromMatrixPosition(anchorGroup.matrix);
      const jump = tmpV.distanceTo(state.anchorLastPos);
      if (jump > 0.02) {
        state.anchorCorrections++;
        perf.log(`Anchor corrected by ${(jump * 100).toFixed(1)} cm`);
      }
      state.anchorLastPos.copy(tmpV);
    }
  }

  const dist = state.placed ? state.viewerPos.distanceTo(tmpV.setFromMatrixPosition(anchorGroup.matrix)) : null;
  perf.sample('distance_m', dist);
  if (state.frameCount % 10 === 0) {
    perf.set('Tracking', {
      state: tracking ? (viewerPose.emulatedPosition ? 'limited (emulated)' : 'tracking') : 'LOST',
      'lost count': state.trackingLost,
      surface: state.placed ? 'placed' : state.lastHit ? (state.hitHorizontal ? 'horizontal' : 'not horizontal') : 'searching',
      anchor: state.anchor ? (frame.trackedAnchors?.has(state.anchor) ? 'tracked' : 'not tracked') : (state.placed ? 'none (static pose)' : '-'),
      'anchor fixes': state.anchorCorrections,
      distance: dist != null ? `${dist.toFixed(2)} m` : '-',
      'phone height': state.placed ? `${(state.viewerPos.y - anchorGroup.matrix.elements[13]).toFixed(2)} m` : '-',
    });
  }
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

function onFrame(t, frame) {
  perf.frameBegin(t);
  state.frameCount++;
  timer.update(t);
  const dt = Math.min(timer.getDelta(), 0.1);

  if (frame && state.session) updateXR(frame);
  else controls.update();

  if (state.animate) for (const inst of state.instances) inst.mixer?.update(dt);
  updateSun();

  perf.gpuBegin();
  renderer.render(scene, camera);
  perf.gpuEnd();
  perf.frameEnd();
}
renderer.setAnimationLoop(onFrame);

function onResize() {
  if (renderer.xr.isPresenting) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
addEventListener('resize', onResize);

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  document.body.className = `mode-${mode}`;
  $('btnExit').textContent = mode === 'ar' ? 'Exit AR' : 'Menu';
}

function setHint(text) { $('hint').textContent = text; }

function benchMeta() {
  return {
    mode: state.mode,
    model: state.model?.name,
    copies: state.clones,
    trianglesScene: state.model ? state.model.stats.triangles * state.clones : 0,
    material: state.matMode,
    shadow: state.shadowMode,
    animating: state.animate,
    worldSize: state.model ? +(Math.max(state.model.size.x, state.model.size.y, state.model.size.z) * contentScale()).toFixed(3) : null,
    msaa: antialias,
    xr: state.session ? perf.sections.get('XR') : null,
  };
}

$('enterAR').addEventListener('click', startAR);
$('preview').addEventListener('click', () => { setMode('preview'); perf.resetTiming(); });
$('btnExit').addEventListener('click', () => (state.session ? state.session.end() : setMode('menu')));

$('btnMove').addEventListener('click', () => {
  state.locked = !state.locked;
  $('btnMove').classList.toggle('on', !state.locked);
  setHint(state.locked ? '' : 'Aim at the floor and tap to move the model');
});

const SCALE_STEP = 1.25;
$('btnBigger').addEventListener('click', () => { state.realScale = false; state.targetSize *= SCALE_STEP; updateScaleInfo(); });
$('btnSmaller').addEventListener('click', () => { state.realScale = false; state.targetSize /= SCALE_STEP; updateScaleInfo(); });
$('btnReal').addEventListener('click', () => {
  state.realScale = !state.realScale;
  $('btnReal').classList.toggle('on', state.realScale);
  updateScaleInfo();
});
$('btnRotate').addEventListener('click', () => { state.yaw += Math.PI / 4; updateScaleInfo(); });

$('btnClones').addEventListener('click', () => { state.clones++; rebuildInstances(); applyMaterialMode(); perf.log(`Copies: ${state.clones}`); });
$('btnClonesMinus').addEventListener('click', () => {
  if (state.clones > 1) { state.clones--; rebuildInstances(); applyMaterialMode(); perf.log(`Copies: ${state.clones}`); }
});

$('btnAnim').classList.add('on');
$('btnAnim').addEventListener('click', () => {
  state.animate = !state.animate;
  $('btnAnim').classList.toggle('on', state.animate);
  updateScaleInfo();
});

$('btnShadow').addEventListener('click', () => {
  state.shadowMode = { blob: 'map', map: 'off', off: 'blob' }[state.shadowMode];
  $('btnShadow').textContent = `Shadow: ${state.shadowMode}`;
  applyShadowMode();
  updateScaleInfo();
  perf.log(`Shadow mode: ${state.shadowMode}`);
});
$('btnShadow').textContent = 'Shadow: blob';

const MAT_MODES = ['original', 'lambert', 'unlit', 'normals'];
$('btnMat').addEventListener('click', () => {
  state.matMode = MAT_MODES[(MAT_MODES.indexOf(state.matMode) + 1) % MAT_MODES.length];
  $('btnMat').textContent = `Mat: ${state.matMode}`;
  applyMaterialMode();
  perf.log(`Material mode: ${state.matMode}`);
});
$('btnMat').textContent = 'Mat: original';

$('btnFps').addEventListener('click', async () => {
  const s = state.session;
  if (!s?.supportedFrameRates?.length) return;
  const rates = [...s.supportedFrameRates];
  const next = rates[(rates.indexOf(s.frameRate) + 1) % rates.length];
  try {
    await s.updateTargetFrameRate(next);
    perf.targetHz = next;
    perf.set('XR', { 'frame rate': `${next} Hz` });
    perf.log(`Target frame rate: ${next} Hz`);
  } catch (e) { perf.log(`updateTargetFrameRate failed: ${e.message}`, 'warn'); }
});

$('btnHud').textContent = 'HUD: compact';
$('btnHud').addEventListener('click', () => { $('btnHud').textContent = `HUD: ${perf.cycleMode()}`; });
$('btnLog').addEventListener('click', () => {
  $('log').classList.toggle('hidden');
  $('btnLog').classList.toggle('on', !$('log').classList.contains('hidden'));
});
$('btnBench').addEventListener('click', () => {
  const started = perf.startBenchmark(10, benchMeta, (r) => {
    $('btnBench').classList.remove('on');
    setHint(`Bench: ${r.fpsAvg} fps avg · 1% low ${r.fps1Low} · p95 ${r.msP95} ms`);
    perf.sendReport(perf.buildReport({ trigger: 'benchmark', settings: benchMeta() }));
  });
  if (started) { $('btnBench').classList.add('on'); setHint('Benchmarking 10 s… keep moving naturally'); }
});
$('btnReport').addEventListener('click', () => perf.sendReport(perf.buildReport({ trigger: 'manual', settings: benchMeta() })));

// Settings card
$('foveation').addEventListener('input', (e) => { $('foveationVal').textContent = e.target.value; });
$('aa').checked = antialias;
$('aa').addEventListener('change', (e) => {
  params.set('aa', e.target.checked ? '1' : '0');
  if ($('modelSelect').value) params.set('model', $('modelSelect').value);
  location.search = params.toString();
});
if (params.get('fb')) $('fbScale').value = params.get('fb');
$('fileInput').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) loadModel({ name: f.name, file: f });
});
$('modelSelect').addEventListener('change', (e) => {
  params.set('model', e.target.value);
  history.replaceState(null, '', `?${params}`);
  loadModel({ url: e.target.value, name: e.target.selectedOptions[0].textContent });
});

window.addEventListener('error', (e) => perf.log(`JS error: ${e.message}`, 'error'));
window.addEventListener('unhandledrejection', (e) => perf.log(`Unhandled rejection: ${e.reason?.message || e.reason}`, 'error'));
renderer.domElement.addEventListener('webglcontextlost', () => perf.log('WebGL context LOST (likely out of GPU memory)', 'error'));

// Debug handle for remote DevTools (chrome://inspect).
window.lab = { THREE, renderer, scene, state, perf, loadModel };

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async () => {
  checkXR();
  // models.json is deployed; models.local.json only exists on the dev machine (originals + files >100 MB).
  const readList = async (url) => {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      return res.ok ? await res.json() : [];
    } catch { return []; }
  };
  const [deployed, local] = await Promise.all([readList('models/models.json'), readList('models/models.local.json')]);
  const models = [...deployed, ...local];
  if (!models.length) perf.log('No entries in models/models.json', 'warn');
  const sel = $('modelSelect');
  for (const [label, list] of [['Optimized', deployed], ['Local only (originals / >100 MB)', local]]) {
    if (!list.length) continue;
    const group = document.createElement('optgroup');
    group.label = label;
    for (const m of list) group.append(new Option(m.name, m.url));
    sel.append(group);
  }
  const wanted = params.get('model');
  if (wanted && !models.some((m) => m.url === wanted)) sel.add(new Option(wanted, wanted));
  if (wanted) sel.value = wanted;
  if (sel.value) loadModel({ url: sel.value, name: sel.selectedOptions[0].textContent });
  else $('loadStatus').textContent = 'No models listed. Pick a local .glb file.';
})();
