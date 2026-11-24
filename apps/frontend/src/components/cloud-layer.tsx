import { useEffect, useRef, type RefObject } from 'react';
import type { MapRef } from 'react-map-gl/mapbox';
import { UCR } from '@/lib/utils';

/**
 * Dynamic cloud cover: a soft, drifting cloud layer over the whole map. It dissolves in a circle around the player,
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
};

const MAX_HINTS = 24;
/** The canvas is drawn at this fraction of the screen size. Clouds are soft, so this costs almost no sharpness. */
const RESOLUTION = 0.5;
const FRAME_MS = 1000 / 30;

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
// A field of overlapping round domes (hemispheres) around jittered points: the bulbs of a cumulus cloud.
// Returns the height in .x and the slope in .yz, so the shading can use each dome's real surface angle.
vec3 domes(vec2 p, float t) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float hsum = 0.0, wsum = 0.0;
  vec2 ssum = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 cell = i + g;
      float h1 = hash(cell);
      float h2 = hash(cell + 19.7);
      float h3 = hash(cell + 7.1);
      // Each bulb slowly breathes: its center wanders a little around its home spot.
      vec2 c = vec2(0.2 + 0.6 * h1, 0.2 + 0.6 * h2) + 0.14 * vec2(sin(t * 0.17 + 6.283 * h2), cos(t * 0.13 + 6.283 * h1));
      float rad = 0.62 + 0.45 * h3;
      vec2 d = g + c - f;                          // from this pixel to the bulb's center
      float r2 = dot(d, d) / (rad * rad);
      if (r2 < 1.0) {
        float dome = sqrt(1.0 - r2) * rad;         // height of a hemisphere
        float wgt = dome * dome * dome;            // taller bulbs count for more where two overlap: a soft union
        hsum += wgt * dome;
        ssum += wgt * (d / max(dome, 0.15));
        wsum += wgt;
      }
    }
  }
  float inv = 1.0 / max(wsum, 0.0001);
  return vec3(hsum * inv, ssum * inv);
}

void main() {
  vec2 w = mix(mix(uBL, uBR, vUv.x), mix(uTL, uTR, vUv.x), vUv.y);
  float t = uTime;

  // Bulbs about 150 m across, drifting slowly and gently changing (the warp moves against the wind).
  vec2 q = w / 300.0;
  float warp = fbm(q * 0.5 + vec2(-t * 0.004, t * 0.003) + 7.3);
  vec2 qq = q + vec2(t * 0.010, t * 0.004) + warp * 0.5;
  // Wobble the shapes so the bulbs are lumpy and irregular rather than neat rounds.
  qq += 0.30 * (vec2(fbm(qq * 1.9 + 2.1), fbm(qq * 1.9 + 8.7)) - 0.5);
  float big = fbm(qq * 0.45 + 3.1);                       // large-scale variation, used for the ragged edges

  vec3 bulbs = domes(qq, t);                              // big bulbs
  vec3 fine = domes(qq * 2.3 + 5.7, t * 1.3);             // small bulbs growing on them
  float height = bulbs.x + 0.22 * fine.x;
  vec2 slope = bulbs.yz + 0.25 * fine.yz;

  // Lit from the up-left: bright on the side of each bulb that faces the light, soft blue-grey on the other side.
  vec3 normal = normalize(vec3(-slope, 1.3));
  vec3 toLight = normalize(vec3(-0.45, 0.6, 0.65));
  float diffuse = clamp(dot(normal, toLight), 0.0, 1.0);
  float open = smoothstep(0.0, 0.40, height);             // the gaps and creases between bulbs are darker
  vec3 shade = vec3(0.60, 0.70, 0.86);
  vec3 light = vec3(1.0, 1.0, 1.0);
  vec3 col = mix(shade, light, clamp(diffuse * 0.95 + 0.10, 0.0, 1.0) * mix(0.55, 1.0, open));
  float body = 1.0;                                       // solid: the clouds do not show the map through them

  // Clear circle around the player, with a ragged, wispy edge.
  float d = length(w - uUser);
  float edge = d + (big - 0.5) * uDissolve * 0.7;
  float cover = mix(1.0, smoothstep(uDissolve, uDissolve * 1.45, edge), uHasUser);

  // A big soft glow in the protein's color, centered near (not on) each hidden protein.
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < ${MAX_HINTS}; i++) {
    if (i >= uCount) break;
    float r = uHint[i].z;
    float dist = length(w - uHint[i].xy) + (big - 0.5) * r * 0.35;
    float g = 1.0 - smoothstep(0.0, r, dist);
    g = g * g * (3.0 - 2.0 * g);
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
      user: at('uUser'), count: at('uCount'), hint: at('uHint[0]'), hintColor: at('uHintColor[0]'),
    };
    const hintData = new Float32Array(MAX_HINTS * 4);
    const colorData = new Float32Array(MAX_HINTS * 3);
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

      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    frame = requestAnimationFrame(draw);

    // Only free what this run made. The context itself must stay alive: React (in development) runs the effect, cleans
    // up, and runs it again on the same canvas, and a context that was force-lost cannot be reused.
    return () => {
      cancelAnimationFrame(frame);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    };
  }, []);

  // Laid over the map but never in the way: touches and clicks go straight through to it.
  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none absolute inset-0 z-[1] h-full w-full" />;
}
