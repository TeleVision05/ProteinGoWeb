import * as THREE from 'three';

// Fun facts, matched against the protein name or model URL. First match wins; edit freely.
export const FACTS = [
  {
    match: /h(a)?emoglobin/i,
    title: 'Hemoglobin',
    fact: 'One red blood cell holds roughly 270 million hemoglobin molecules, and each one can carry up to four oxygen molecules. The iron in its heme groups is what makes blood red.',
  },
  {
    match: /actin|myosin/i,
    title: 'Actin and Myosin',
    fact: 'Muscles contract when myosin heads grab actin filaments and pull, like tiny oars. Every single stroke is powered by one ATP molecule.',
  },
  {
    match: /receptor/i,
    title: 'Receptors',
    fact: 'Receptors work like locks on the cell surface. When the right molecule binds, the receptor changes shape and passes a signal inside. Roughly a third of all drugs target just one receptor family, the GPCRs.',
  },
];

const FALLBACK = {
  title: 'Protein',
  fact: 'Proteins are chains of amino acids that fold into 3D shapes, and that shape decides what they do. Your body uses tens of thousands of different ones.',
};

export function factFor(...names: (string | null | undefined)[]) {
  const text = names.filter(Boolean).join(' ');
  return FACTS.find((f) => f.match.test(text)) ?? FALLBACK;
}

const FONT = 'system-ui, -apple-system, Segoe UI, sans-serif';

export const SHADOW_PAD = 0;

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * A flat textured card. The caller turns it to face the viewer every frame. `anchorX`/`anchorY` say which point of the card sits at its position (0..1, from bottom-left).
 */
function billboardFrom(canvas: HTMLCanvasElement, anchorX = 0.5, anchorY = 0.5) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const geometry = new THREE.PlaneGeometry(1, 1).translate(0.5 - anchorX, 0.5 - anchorY, 0);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 20;
  mesh.userData.aspect = canvas.width / canvas.height;
  return mesh;
}

export function disposeSprite(mesh: THREE.Mesh | null) {
  if (!mesh) return;
  mesh.removeFromParent();
  (mesh.material as THREE.MeshBasicMaterial).map?.dispose();
  (mesh.material as THREE.Material).dispose();
  mesh.geometry.dispose();
}

// Thought bubble above the protein: "Tap me to learn more!" with two little trailing bubbles.
// Its bottom-centre (the trail) is the sprite's anchor, so it floats just above the position it is given.
export function makeThoughtBubble(line1 = 'Tap me to', line2 = 'learn more!') {
  const canvas = document.createElement('canvas');
  canvas.width = 512 + SHADOW_PAD * 2;
  canvas.height = 300 + SHADOW_PAD * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(SHADOW_PAD, SHADOW_PAD);
  ctx.lineWidth = 7;
  ctx.strokeStyle = '#4fd1a5';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.96)';
  // Cloud-ish body: a rounded pill with a few bumps.
  roundRect(ctx, 12, 12, 488, 196, 98);
  ctx.fill();
  ctx.stroke();
  // Trail of two shrinking bubbles.
  for (const [x, y, r] of [[290, 232, 17], [262, 272, 10]] as const) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = '#0b2540';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 62px ${FONT}`;
  ctx.fillText(line1, 256, 82);
  ctx.fillStyle = '#1f7a4d';
  ctx.fillText(line2, 256, 148);
  // Anchored at the trail so it points down at the protein.
  return billboardFrom(canvas, 0.55, 0);
}

// Fun-fact card. The returned sprite's userData.aspect is width / height.
export function makeFactCard({ title, fact }: { title: string; fact: string }) {
  const W = 1024;
  const pad = 56;
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = `400 46px ${FONT}`;
  const lines = wrap(probe, fact, W - pad * 2);
  const lineH = 62;
  const H = pad + 70 + 28 + lines.length * lineH + 44 + 40 + pad / 2;

  const canvas = document.createElement('canvas');
  canvas.width = W + SHADOW_PAD * 2;
  canvas.height = H + SHADOW_PAD * 2;
  const ctx = canvas.getContext('2d')!;
  ctx.translate(SHADOW_PAD, SHADOW_PAD);
  roundRect(ctx, 8, 8, W - 16, H - 16, 48);
  ctx.fillStyle = 'rgba(10, 24, 40, 0.92)';
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#4fd1a5';
  ctx.stroke();

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#4fd1a5';
  ctx.font = `700 28px ${FONT}`;
  ctx.fillText('FUN FACT', pad, pad + 20);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 62px ${FONT}`;
  ctx.fillText(title, pad, pad + 20 + 70);
  ctx.fillStyle = '#dbe7f3';
  ctx.font = `400 46px ${FONT}`;
  lines.forEach((line, i) => ctx.fillText(line, pad, pad + 20 + 70 + 28 + 46 + i * lineH));
  ctx.fillStyle = 'rgba(219, 231, 243, 0.55)';
  ctx.font = `400 30px ${FONT}`;
  ctx.fillText('Tap anywhere to close', pad, H - pad / 2 - 6);
  return billboardFrom(canvas);
}
