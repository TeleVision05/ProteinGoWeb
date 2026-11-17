import * as THREE from 'three';

// The pedestal the protein stands on, and the control screen that slides out of it.
//
// The pedestal is built from code (one lathed body and two glowing rings), so it costs three draw calls, scales
// with the protein, and needs no model file. The screen is a tilted slab that slides out of the pedestal's side
// that faces the viewer. What is on the screen is a list of sections ("Style", "Animation", ...): add a section
// to `ConsoleState`, `heightFor`, `paint` and `ConsoleAction` to add a setting.

export type StyleChoice = 'ribbon' | 'sphere';

/** Everything the screen shows. A section whose value is null is left out. */
export type ConsoleState = {
  title: string;
  styles: { options: StyleChoice[]; active: StyleChoice; busy: boolean } | null;
  animation: { playing: boolean; speed: number; seconds: number; duration: number } | null;
  /** Pedestal height in metres, and the range the slider covers. */
  height: { value: number; min: number; max: number } | null;
};

/** What a tap on the screen asks for. */
export type ConsoleAction =
  | { type: 'style'; style: StyleChoice }
  | { type: 'play' }
  | { type: 'restart' }
  | { type: 'speed'; speed: number }
  | { type: 'seek'; fraction: number }
  | { type: 'height'; value: number };

const FONT = 'system-ui, -apple-system, Segoe UI, sans-serif';
const TEAL = '#4fd1a5';

// Screen canvas layout, in pixels. Section heights add up to the canvas height.
const W = 1000;
const PAD = 36;
const HEADER = 96;
const STYLE_H = 166;
const ANIM_H = 246;
const HEIGHT_H = 166;
const HEIGHT_STEP = 0.1; // metres per tap of + or -
const FOOT = 22;
const SPEEDS = [0.5, 1, 2];
const STYLE_LABEL: Record<StyleChoice, string> = { ribbon: 'Ribbon', sphere: 'Spheres' };

/** How far the screen leans back, in radians, so it reads well from above. */
const TILT = 0.55;
const SCREEN_HEIGHT = 0.46; // metres above the floor: the middle of the screen, when the pedestal is tall enough
const SCREEN_EDGE = 0.015; // bezel around the screen, metres
const WALL = 0.86; // the pedestal's side wall, as a fraction of its top radius

/**
 * Pedestal height needed for a screen of this height, in metres: the slab's top edge must stay below the
 * flared rim (the top fifth of the body), or the rim would hide it.
 */
export function pedestalHeightFor(screenHeight: number) {
  return ((screenHeight + SCREEN_EDGE * 2) * Math.cos(TILT) + 0.03) / 0.78;
}

type Hit = { x: number; y: number; w: number; h: number; make: (px: number) => ConsoleAction };

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function heightFor(state: ConsoleState) {
  if (!state.styles && !state.animation && !state.height) return 0;
  return PAD + HEADER + (state.styles ? STYLE_H : 0) + (state.animation ? ANIM_H : 0) + (state.height ? HEIGHT_H : 0) + FOOT;
}

const smooth = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

export function makePedestal() {
  const group = new THREE.Group();

  // ---- The body: a plinth with a wide foot and a flat top, 1 m wide and 1 m high, scaled in layout().
  const profile = [
    [0, 0], [1.2, 0], [1.2, 0.05], [1.1, 0.09], [0.92, 0.13], [0.86, 0.18],
    [0.86, 0.8], [0.92, 0.86], [1.06, 0.91], [1.08, 0.94], [1.08, 1], [0, 1],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const metal = new THREE.MeshStandardMaterial({ color: 0x1d2a38, metalness: 0.55, roughness: 0.42 });
  const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 56), metal);

  // Glowing trim near the top rim and around the foot.
  const trimMat = new THREE.MeshBasicMaterial({ color: 0x4fd1a5, toneMapped: false });
  const ringGeometry = new THREE.TorusGeometry(1, 0.018, 8, 72).rotateX(Math.PI / 2);
  const topRing = new THREE.Mesh(ringGeometry, trimMat);
  const footRing = new THREE.Mesh(ringGeometry, trimMat);

  // Soft contact shadow on the floor around the foot.
  const shade = document.createElement('canvas');
  shade.width = shade.height = 128;
  const sg = shade.getContext('2d')!;
  const grd = sg.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(0,0,0,0.5)');
  grd.addColorStop(0.65, 'rgba(0,0,0,0.28)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  sg.fillStyle = grd;
  sg.fillRect(0, 0, 128, 128);
  const floorShade = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(shade), transparent: true, depthWrite: false }),
  );
  floorShade.position.y = 0.003;

  // ---- The drawer: turns to face the viewer; its slab slides out along +z.
  const drawer = new THREE.Group();
  const slab = new THREE.Group();
  slab.rotation.x = -TILT;
  const bezel = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x131d29, metalness: 0.6, roughness: 0.4 }),
  );
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = 566;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
  );
  slab.add(bezel, screen);
  const slotMat = new THREE.MeshBasicMaterial({ color: 0x03070b, side: THREE.DoubleSide });
  let slot = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true, 0, 1), slotMat);
  drawer.add(slab, slot);

  group.add(floorShade, body, topRing, footRing, drawer);

  // ---- The screen's contents.
  let hits: Hit[] = [];
  let signature = '';
  let aspect = W / 566;
  let hasContent = false;

  function paint(state: ConsoleState, height: number) {
    const ctx = canvas.getContext('2d')!;
    hits = [];
    ctx.clearRect(0, 0, W, height);
    ctx.fillStyle = '#0a1622';
    ctx.fillRect(0, 0, W, height);
    ctx.fillStyle = TEAL;
    ctx.fillRect(0, 0, W, 8);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    let y = PAD;
    ctx.fillStyle = TEAL;
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText('CONTROLS', PAD, y + 24);
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 50px ${FONT}`;
    let title = state.title;
    while (title.length > 3 && ctx.measureText(title).width > W - PAD * 2) title = title.slice(0, -2);
    if (title !== state.title) title = `${title.trimEnd()}…`;
    ctx.fillText(title, PAD, y + 24 + 58);
    y += HEADER;

    const label = (text: string, at: number) => {
      ctx.fillStyle = 'rgba(219, 231, 243, 0.65)';
      ctx.font = `700 24px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(text, PAD, at + 26);
    };

    if (state.styles) {
      const { options, active, busy } = state.styles;
      label('STYLE', y);
      const top = y + 40;
      const h = 96;
      const half = (W - PAD * 2) / options.length;
      roundRect(ctx, PAD, top, W - PAD * 2, h, h / 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(79, 209, 165, 0.55)';
      ctx.stroke();
      options.forEach((option, i) => {
        const x = PAD + i * half;
        const on = option === active;
        if (on) {
          ctx.globalAlpha = busy ? 0.55 : 1;
          ctx.fillStyle = TEAL;
          roundRect(ctx, x + 6, top + 6, half - 12, h - 12, (h - 12) / 2);
          ctx.fill();
        }
        ctx.globalAlpha = busy && !on ? 0.5 : 1;
        ctx.fillStyle = on ? '#06240f' : '#ffffff';
        ctx.font = `700 44px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(on && busy ? 'Loading…' : STYLE_LABEL[option], x + half / 2, top + h / 2 + 2);
        ctx.globalAlpha = 1;
        hits.push({ x, y: top, w: half, h, make: () => ({ type: 'style', style: option }) });
      });
      y += STYLE_H;
    }

    if (state.animation) {
      const { playing, speed, seconds, duration } = state.animation;
      label('ANIMATION', y);
      const top = y + 40;
      const h = 96;
      const button = (x: number, w: number, text: string, on: boolean, action: ConsoleAction) => {
        ctx.fillStyle = on ? TEAL : 'rgba(255, 255, 255, 0.14)';
        roundRect(ctx, x, top, w, h, 26);
        ctx.fill();
        ctx.fillStyle = on ? '#06240f' : '#ffffff';
        ctx.font = `700 38px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x + w / 2, top + h / 2 + 2);
        hits.push({ x, y: top, w, h, make: () => action });
      };
      button(PAD, 210, playing ? 'Pause' : 'Play', false, { type: 'play' });
      button(PAD + 226, 210, 'Restart', false, { type: 'restart' });
      const speedW = 130;
      const speedX = W - PAD - (speedW * SPEEDS.length + 12 * (SPEEDS.length - 1));
      SPEEDS.forEach((value, i) => {
        button(speedX + i * (speedW + 12), speedW, `${value}x`, speed === value, { type: 'speed', speed: value });
      });

      // Scrubber: tap the bar to jump.
      const trackX = PAD;
      const trackW = W - PAD * 2 - 220;
      const trackY = top + h + 24 + 20;
      const frac = duration ? Math.min(1, seconds / duration) : 0;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
      roundRect(ctx, trackX, trackY, trackW, 16, 8);
      ctx.fill();
      ctx.fillStyle = TEAL;
      roundRect(ctx, trackX, trackY, Math.max(16, trackW * frac), 16, 8);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(trackX + trackW * frac, trackY + 8, 21, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(219, 231, 243, 0.8)';
      ctx.font = `400 30px ui-monospace, monospace`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${seconds.toFixed(1)} / ${duration.toFixed(1)} s`, W - PAD, trackY + 8);
      hits.push({
        x: trackX - 24,
        y: trackY - 30,
        w: trackW + 48,
        h: 76,
        make: (px) => ({ type: 'seek', fraction: Math.min(1, Math.max(0, (px - trackX) / trackW)) }),
      });
      y += ANIM_H;
    }

    if (state.height) {
      const { value, min, max } = state.height;
      label('PEDESTAL HEIGHT', y);
      ctx.fillStyle = 'rgba(219, 231, 243, 0.8)';
      ctx.font = `400 30px ui-monospace, monospace`;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(`${value.toFixed(2)} m`, W - PAD, y + 26);
      const top = y + 40;
      const h = 96;
      const clampValue = (v: number) => Math.min(max, Math.max(min, Math.round(v * 20) / 20));
      const step = (x: number, text: string, delta: number) => {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
        roundRect(ctx, x, top, h, h, 26);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = `700 56px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, x + h / 2, top + h / 2 + 2);
        hits.push({ x, y: top, w: h, h, make: () => ({ type: 'height', value: clampValue(value + delta) }) });
      };
      step(PAD, '−', -HEIGHT_STEP);
      step(W - PAD - h, '+', HEIGHT_STEP);
      const trackX = PAD + h + 40;
      const trackW = W - PAD * 2 - (h + 40) * 2;
      const trackY = top + h / 2 - 8;
      const frac = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
      roundRect(ctx, trackX, trackY, trackW, 16, 8);
      ctx.fill();
      ctx.fillStyle = TEAL;
      roundRect(ctx, trackX, trackY, Math.max(16, trackW * frac), 16, 8);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(trackX + trackW * frac, trackY + 8, 21, 0, Math.PI * 2);
      ctx.fill();
      hits.push({
        x: trackX - 24,
        y: top,
        w: trackW + 48,
        h,
        make: (px) => ({ type: 'height', value: clampValue(min + ((px - trackX) / trackW) * (max - min)) }),
      });
    }
  }

  /** Repaint the screen if anything it shows changed. True when the screen's shape changed (re-run layout). */
  function setState(state: ConsoleState): boolean {
    const sig = JSON.stringify([
      state.title,
      state.styles,
      state.animation && [
        state.animation.playing,
        state.animation.speed,
        Math.round(state.animation.seconds * 10),
        Math.round(state.animation.duration * 10),
      ],
      state.height && [Math.round(state.height.value * 100), Math.round(state.height.min * 100), Math.round(state.height.max * 100)],
    ]);
    if (sig === signature) return false;
    signature = sig;
    const height = heightFor(state);
    hasContent = height > 0;
    if (!hasContent) return false;
    let reshaped = false;
    if (height !== canvas.height) {
      canvas.height = height;
      // The texture's size changed: free it so it is uploaded again at the new size.
      texture.dispose();
      aspect = W / height;
      reshaped = true;
    }
    paint(state, height);
    texture.needsUpdate = true;
    return reshaped;
  }

  /** The action under a tap on the screen. u and v are 0..1 from the top-left. */
  function hit(u: number, v: number): ConsoleAction | null {
    const px = u * W;
    const py = v * canvas.height;
    const found = hits.find((item) => px >= item.x && px <= item.x + item.w && py >= item.y && py <= item.y + item.h);
    return found ? found.make(px) : null;
  }

  // ---- Geometry that depends on the protein's size.
  let zOpen = 0;
  let zClosed = 0;
  let laidOut = '';

  /** radius: top radius of the pedestal, height: its height, width: the screen's width (all metres). */
  function layout(radius: number, height: number, width: number) {
    const sizeKey = [radius, height, width, aspect].map((n) => n.toFixed(4)).join('|');
    if (sizeKey === laidOut) return;
    laidOut = sizeKey;

    body.scale.set(radius, height, radius);
    topRing.scale.setScalar(radius * 1.085);
    topRing.position.y = height * 0.965;
    footRing.scale.setScalar(radius * 1.2);
    footRing.position.y = height * 0.02;
    floorShade.scale.setScalar(radius * 3.4);

    const sh = width / aspect;
    bezel.scale.set(width + SCREEN_EDGE * 2, sh + SCREEN_EDGE * 2, 0.03);
    screen.scale.set(width, sh, 1);
    screen.position.z = 0.0155;
    const wall = radius * WALL;
    const half = (sh / 2 + SCREEN_EDGE);
    // The screen stays at one comfortable hand height however tall the pedestal is, so a button does not move away
    // from your finger while you raise or lower the pedestal. Only a short pedestal pulls it lower, to keep its top
    // edge below the flared rim.
    const centreY = Math.max(0.03 + half * Math.cos(TILT), Math.min(SCREEN_HEIGHT, height * 0.76 - half * Math.cos(TILT)));
    // The slab's top edge stays just inside the wall, so it looks like it comes out of the pedestal.
    zOpen = wall + half * Math.sin(TILT) - 0.01;
    zClosed = wall * 0.3;
    slab.position.y = centreY;

    // A dark slot on the wall where the slab leaves it.
    drawer.remove(slot);
    slot.geometry.dispose();
    const arc = 2 * Math.asin(Math.min(1, (width + 0.05) / 2 / (wall + 0.002)));
    slot = new THREE.Mesh(new THREE.CylinderGeometry(wall + 0.002, wall + 0.002, 0.032, 24, 1, true, -arc / 2, arc), slotMat);
    slot.position.y = centreY + (zOpen - wall) / Math.tan(TILT);
    drawer.add(slot);
  }

  /** Turn the drawer toward `yaw` (radians about the vertical) and slide it out by `open` (0 shut, 1 out). */
  function aim(yaw: number, open: number) {
    drawer.rotation.y = yaw;
    const t = hasContent ? smooth(open) : 0;
    drawer.visible = hasContent;
    slab.visible = t > 0.005;
    slab.position.z = zClosed + (zOpen - zClosed) * t;
  }

  function dispose() {
    for (const mesh of [body, topRing, footRing, floorShade, bezel, screen, slot]) {
      mesh.geometry.dispose();
    }
    for (const material of [metal, trimMat, slotMat, bezel.material, screen.material, floorShade.material]) {
      (material as THREE.Material).dispose();
    }
    texture.dispose();
    (floorShade.material as THREE.MeshBasicMaterial).map?.dispose();
    group.removeFromParent();
  }

  return {
    group,
    /** Tap target: tapping the pedestal slides the screen out or back in. */
    body,
    /** Tap target for the controls. */
    screen,
    setState,
    hit,
    layout,
    aim,
    dispose,
    get aspect() {
      return aspect;
    },
    get hasContent() {
      return hasContent;
    },
  };
}
