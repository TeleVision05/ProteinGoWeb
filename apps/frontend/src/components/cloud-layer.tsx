import { useEffect, useRef, type RefObject } from 'react';
import type { MapRef } from 'react-map-gl/mapbox';
import type { ExploredStore } from '@/lib/explored';
import { UCR } from '@/lib/utils';

/**
 * Dynamic cloud cover: a soft, drifting fog layer over the whole map. It dissolves in a circle around the player,
 * and shows a big colored glow inside the clouds where a protein is hiding.
 *
 * It is one full-screen shader drawn on its own small canvas laid over the map (the map keeps working underneath),
 * at half resolution and at most 30 frames a second, and it stops while the page is hidden. That keeps it light on a phone.
 */

export type CloudHint = { lat: number; lng: number; color: string };

type Props = {
  mapRef: RefObject<MapRef | null>;
  user: { lat: number; lng: number } | null;
  /** Meters around the player where the clouds are fully gone. */
  dissolveRadius: number;
  /** Meters: how big each protein's colored glow is. */
  hintRadius: number;
  /** 0 to 90, percent. Higher shows more of the map through the clouds. */
  transparency: number;
  hints: CloudHint[];
  /** The squares the player has walked through: the fog stays cleared there. */
  explored?: ExploredStore | null;
};

const MAX_HINTS = 24;
/** The canvas is drawn at this fraction of the screen size. Clouds are soft, so this costs almost no sharpness. */
const RESOLUTION = 0.5;
const FRAME_MS = 1000 / 30;
/** The explored mask covers a square this many meters on a side around the campus point, at MASK_SIZE pixels. */
const MASK_SPAN = 6000;
const MASK_SIZE = 1024;
/** Explored ground fades back to fog over a wide band: fully clear to the dissolve radius, gone at this many times it. */
const FADE_OUT = 1.8;

// Local meters from a fixed point on campus: small numbers keep the shader's math precise.
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LNG = 111_320 * Math.cos((UCR.lat * Math.PI) / 180);
const toLocal = (lat: number, lng: number): [number, number] => [(lng - UCR.lng) * M_PER_DEG_LNG, (lat - UCR.lat) * M_PER_DEG_LAT];

const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT = `
precision highp float;
varying vec2 vUv;
uniform vec2 uTL, uTR, uBL, uBR;   // the map's four screen corners, in local meters
uniform float uTime, uDissolve, uOpacity, uHasUser;
uniform vec2 uUser;
uniform int uCount;
uniform vec4 uHint[${MAX_HINTS}];      // x, y, radius
uniform vec3 uHintColor[${MAX_HINTS}];
uniform sampler2D uExplored;       // ground the player has already cleared (white = cleared)

float smoother(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * noise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return s;
}
void main() {
  vec2 w = mix(mix(uBL, uBR, vUv.x), mix(uTL, uTR, vUv.x), vUv.y);
  float t = uTime;

  // Fog: broad, soft banks that drift slowly and keep changing shape. The slow warp moves against the wind.
  vec2 q = w / 380.0;
  vec2 wind = vec2(t * 0.012, t * 0.005);
  float warp = fbm(q * 0.6 + vec2(-t * 0.004, t * 0.003) + 7.3);
  vec2 p = q + wind + warp * 0.9;

  float banks = fbm(p);                                              // broad banks of thicker and thinner fog
  float wisps = fbm(vec2(p.x * 0.55, p.y * 1.5) + vec2(t * 0.006, -t * 0.002) + 4.4); // long streaks, drifting at their own pace
  float grain = fbm(p * 2.6 - wind * 1.6 + 9.1);                     // fine, faint texture
  float density = banks * 0.55 + wisps * 0.30 + grain * 0.15;

  // A very gentle sense of depth: the banks are a touch brighter on the side facing the light (up and left).
  float banksLit = fbm(p + vec2(-0.05, 0.06));
  float depth = clamp(0.5 + (banks - banksLit) * 3.0, 0.0, 1.0);

  // Thin fog is a cool grey, thick fog is near white.
  vec3 thin = vec3(0.66, 0.73, 0.80);
  vec3 thick = vec3(0.97, 0.98, 0.99);
  float whiteness = smoothstep(0.28, 0.72, density) * 0.85 + depth * 0.15;
  vec3 col = mix(thin, thick, clamp(whiteness, 0.0, 1.0));
  float big = banks;                                                 // used below for the ragged edges
  float body = 1.0;                                                  // solid: the map does not show through at 0% transparency

  // Where the player is now: fully clear within the dissolve radius, then a long soft fade back into fog.
  float d = length(w - uUser);
  float edge = d + (big - 0.5) * uDissolve * 0.6;
  float live = mix(1.0, smoother(uDissolve, uDissolve * ${FADE_OUT.toFixed(1)}, edge), uHasUser);
  // Where the player has been before: stays cleared, with the same soft, slightly wispy edge.
  vec2 mw = w + (big - 0.5) * uDissolve * 0.5;
  float seen = texture2D(uExplored, (mw + ${(MASK_SPAN / 2).toFixed(1)}) / ${MASK_SPAN.toFixed(1)}).r;
  float cover = min(live, 1.0 - smoothstep(0.1, 0.9, seen));

  // A big soft glow in the protein's color, centered near (not on) each hidden protein.
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < ${MAX_HINTS}; i++) {
    if (i >= uCount) break;
    float r = uHint[i].z;
    float dist = length(w - uHint[i].xy) + (big - 0.5) * r * 0.35;
    // A wide, gentle bell: strongest in the middle and fading gradually all the way out to the radius.
    float x = clamp(dist / r, 0.0, 1.0);
    float g = max(0.0, (exp(-2.6 * x * x) - 0.0743) / 0.9257);
    acc += uHintColor[i] * g;
    wsum += g;
  }
  float amt = clamp(wsum, 0.0, 1.0);
  vec3 hintCol = acc / max(wsum, 0.001);
  float pulse = 0.9 + 0.1 * sin(t * 0.9);
  col = mix(col, hintCol, amt * 0.7 * pulse);

  float a = cover * body * uOpacity;
  gl_FragColor = vec4(col * a, a);                    // premultiplied
}`;

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.replace(/./g, (c) => c + c) : value;
  const n = parseInt(full, 16);
  return Number.isFinite(n) ? [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] : [0.5, 0.5, 0.5];
}

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn('Cloud shader failed:', gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function CloudLayer(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The latest props, read by the draw loop, so changing them never rebuilds the GL setup.
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power',
    });
    if (!gl) return;
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = gl.createProgram();
    if (!vertex || !fragment || !program) return;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('Cloud program failed:', gl.getProgramInfoLog(program));
      return;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW); // one big triangle
    const position = gl.getAttribLocation(program, 'aPos');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    const at = (name: string) => gl.getUniformLocation(program, name);
    const u = {
      tl: at('uTL'), tr: at('uTR'), bl: at('uBL'), br: at('uBR'),
      time: at('uTime'), dissolve: at('uDissolve'), opacity: at('uOpacity'), hasUser: at('uHasUser'),
      user: at('uUser'), count: at('uCount'), hint: at('uHint[0]'), hintColor: at('uHintColor[0]'), explored: at('uExplored'),
    };
    const hintData = new Float32Array(MAX_HINTS * 4);
    const colorData = new Float32Array(MAX_HINTS * 3);

    // The explored mask: a grey-scale picture of the ground the player has cleared, drawn once per new square.
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = maskCanvas.height = MASK_SIZE;
    const maskCtx = maskCanvas.getContext('2d');
    const maskTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, maskTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(u.explored, 0);
    let maskRadius = -1;
    let maskResets = -1;
    let maskVersion = -1;
    const blank = () => {
      if (!maskCtx) return;
      maskCtx.globalCompositeOperation = 'source-over';
      maskCtx.fillStyle = '#000';
      maskCtx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
      maskCtx.globalCompositeOperation = 'lighten'; // overlapping circles keep the brighter (more cleared) value
    };
    blank();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
    const stamp = (cx: number, cy: number, radius: number, cellMeters: number) => {
      if (!maskCtx) return;
      const scale = MASK_SIZE / MASK_SPAN;
      const x = ((cx + 0.5) * cellMeters + MASK_SPAN / 2) * scale;
      const y = (MASK_SPAN / 2 - (cy + 0.5) * cellMeters) * scale;
      const r = radius * FADE_OUT * scale;
      const g = maskCtx.createRadialGradient(x, y, 0, x, y, r);
      // Clear out to the dissolve radius, then an eased fade to nothing at FADE_OUT times that.
      const clear = 1 / FADE_OUT;
      g.addColorStop(0, '#fff');
      g.addColorStop(clear, '#fff');
      [[0.12, '#ebebeb'], [0.32, '#b8b8b8'], [0.55, '#666'], [0.78, '#242424'], [1, '#000']].forEach(([t, color]) =>
        g.addColorStop(clear + (1 - clear) * (t as number), color as string),
      );
      maskCtx.fillStyle = g;
      maskCtx.fillRect(x - r, y - r, r * 2, r * 2);
    };
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const speed = reduceMotion ? 0.15 : 1;
    const shown: [number, number] = [0, 0]; // the player's position as drawn: eases toward the real one
    let haveShown = false;
    let frame = 0;
    let last = 0;

    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (document.hidden || now - last < FRAME_MS || gl.isContextLost()) return;
      last = now;
      const p = latest.current;
      const map = p.mapRef.current?.getMap();
      if (!map) return;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;
      const bufferW = Math.max(2, Math.round(width * RESOLUTION));
      const bufferH = Math.max(2, Math.round(height * RESOLUTION));
      if (canvas.width !== bufferW || canvas.height !== bufferH) {
        canvas.width = bufferW;
        canvas.height = bufferH;
      }
      gl.viewport(0, 0, bufferW, bufferH);

      // Where the four screen corners are on the ground, so the clouds stay put on the map as it moves.
      const corner = (x: number, y: number) => {
        const c = map.unproject([x, y]);
        return toLocal(c.lat, c.lng);
      };
      gl.uniform2fv(u.tl, corner(0, 0));
      gl.uniform2fv(u.tr, corner(width, 0));
      gl.uniform2fv(u.bl, corner(0, height));
      gl.uniform2fv(u.br, corner(width, height));

      const target = p.user ? toLocal(p.user.lat, p.user.lng) : null;
      if (target) {
        if (!haveShown) {
          shown[0] = target[0];
          shown[1] = target[1];
          haveShown = true;
        } else {
          shown[0] += (target[0] - shown[0]) * 0.12;
          shown[1] += (target[1] - shown[1]) * 0.12;
        }
      }
      gl.uniform2f(u.user, shown[0], shown[1]);
      gl.uniform1f(u.hasUser, target ? 1 : 0);
      gl.uniform1f(u.dissolve, p.dissolveRadius);
      gl.uniform1f(u.opacity, 1 - Math.min(90, Math.max(0, p.transparency)) / 100);
      gl.uniform1f(u.time, ((now / 1000) * speed) % 100_000);

      // The nearest hints to the player (or the map's middle when there is no GPS), up to the shader's limit.
      const middle = target ?? corner(width / 2, height / 2);
      const ranked = p.hints
        .map((hint) => ({ hint, at: toLocal(hint.lat, hint.lng) }))
        .sort((a, b) => Math.hypot(a.at[0] - middle[0], a.at[1] - middle[1]) - Math.hypot(b.at[0] - middle[0], b.at[1] - middle[1]))
        .slice(0, MAX_HINTS);
      ranked.forEach(({ hint, at: pos }, i) => {
        hintData.set([pos[0], pos[1], p.hintRadius, 0], i * 4);
        colorData.set(hexToRgb(hint.color), i * 3);
      });
      gl.uniform1i(u.count, ranked.length);
      gl.uniform4fv(u.hint, hintData);
      gl.uniform3fv(u.hintColor, colorData);

      // Bring the explored mask up to date: everything again if the radius changed or squares were just loaded,
      // otherwise only the squares added since the last frame.
      const store = p.explored;
      let maskDirty = false;
      if (store && (maskRadius !== p.dissolveRadius || maskResets !== store.resets)) {
        blank();
        for (const [cx, cy] of store.all()) stamp(cx, cy, p.dissolveRadius, store.cellMeters);
        store.takeFresh();
        maskRadius = p.dissolveRadius;
        maskResets = store.resets;
        maskVersion = store.version;
        maskDirty = true;
      } else if (store && maskVersion !== store.version) {
        for (const [cx, cy] of store.takeFresh()) stamp(cx, cy, p.dissolveRadius, store.cellMeters);
        maskVersion = store.version;
        maskDirty = true;
      }
      if (maskDirty) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
      }

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    frame = requestAnimationFrame(draw);

    // Only free what this run made. The context itself must stay alive: React (in development) runs the effect, cleans
    // up, and runs it again on the same canvas, and a context that was force-lost cannot be reused.
    return () => {
      cancelAnimationFrame(frame);
      gl.deleteBuffer(buffer);
      gl.deleteTexture(maskTexture);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };
  }, []);

  // Laid over the map but never in the way: touches and clicks go straight through to it.
  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 z-[1] h-full w-full" />;
}
