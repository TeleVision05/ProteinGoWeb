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

export type QuizPhase = 'asking' | 'checking' | 'wrong' | 'correct';
export type QuizView = {
  phase: QuizPhase;
  /** Option last tapped, or -1. */
  picked: number;
  /** Shown in the status row: the server's reason after a wrong answer, or the reward after a right one. */
  message: string;
  /** Seconds until options can be tapped again after a wrong answer. */
  secondsLeft: number;
};

const LETTERS = ['A', 'B', 'C', 'D'];

/**
 * The in-world question panel: the question and 2 to 4 answer buttons on one flat card.
 * `draw` repaints it for a state, `hit` turns a tap position (0..1, origin top-left) into an option index.
 * The card's bottom-centre is its anchor, so it floats just above the position it is given.
 */
export function makeQuizPanel(question: string, options: string[]) {
  const W = 1024;
  const pad = 52;
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = `700 54px ${FONT}`;
  const questionLines = wrap(probe, question, W - pad * 2);
  const questionLineH = 68;
  const badge = 76;
  const optionTextW = W - pad * 2 - badge - 64;
  probe.font = `600 44px ${FONT}`;
  const optionLines = options.map((option) => wrap(probe, option, optionTextW));
  const optionH = optionLines.map((lines) => Math.max(116, 44 + lines.length * 56));
  const gap = 20;
  const headerH = 62;
  const statusH = 92;
  const top = pad;
  const questionTop = top + headerH;
  const optionsTop = questionTop + questionLines.length * questionLineH + 30;
  const rects: { y: number; h: number }[] = [];
  let y = optionsTop;
  for (const h of optionH) {
    rects.push({ y, h });
    y += h + gap;
  }
  const statusTop = y - gap + 26;
  const H = statusTop + statusH + pad * 0.5;

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  function draw(view: QuizView) {
    ctx.clearRect(0, 0, W, H);
    roundRect(ctx, 8, 8, W - 16, H - 16, 48);
    ctx.fillStyle = 'rgba(10, 24, 40, 0.95)';
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = view.phase === 'correct' ? '#4fd1a5' : view.phase === 'wrong' ? '#e05252' : '#4fd1a5';
    ctx.stroke();

    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#4fd1a5';
    ctx.font = `700 28px ${FONT}`;
    ctx.fillText('QUESTION', pad, top + 28);
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 54px ${FONT}`;
    questionLines.forEach((line, i) => ctx.fillText(line, pad, questionTop + 54 + i * questionLineH));

    options.forEach((_, i) => {
      const { y: oy, h } = rects[i];
      const isPicked = view.picked === i;
      const wrong = isPicked && view.phase === 'wrong';
      const right = isPicked && view.phase === 'correct';
      const busy = isPicked && view.phase === 'checking';
      const dim = (view.phase === 'checking' || view.phase === 'correct') && !isPicked;
      ctx.globalAlpha = dim ? 0.4 : view.phase === 'wrong' && !isPicked && view.secondsLeft > 0 ? 0.65 : 1;
      ctx.fillStyle = right
        ? '#4fd1a5'
        : wrong
          ? 'rgba(224, 82, 82, 0.55)'
          : busy
            ? 'rgba(79, 209, 165, 0.35)'
            : 'rgba(255, 255, 255, 0.14)';
      roundRect(ctx, pad, oy, W - pad * 2, h, 28);
      ctx.fill();
      // Letter badge.
      ctx.fillStyle = right ? '#06240f' : 'rgba(255, 255, 255, 0.22)';
      ctx.beginPath();
      ctx.arc(pad + 24 + badge / 2, oy + h / 2, badge / 2 - 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = right ? '#4fd1a5' : '#ffffff';
      ctx.font = `700 40px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(LETTERS[i] ?? String(i + 1), pad + 24 + badge / 2, oy + h / 2 + 2);
      // Answer text.
      ctx.fillStyle = right ? '#06240f' : '#ffffff';
      ctx.font = `600 44px ${FONT}`;
      ctx.textAlign = 'left';
      const lines = optionLines[i];
      const textTop = oy + h / 2 - ((lines.length - 1) * 56) / 2;
      lines.forEach((line, li) => ctx.fillText(line, pad + 24 + badge + 28, textTop + li * 56 + 2));
      ctx.globalAlpha = 1;
    });

    // Status row.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cy = statusTop + statusH / 2;
    if (view.phase === 'checking') {
      ctx.fillStyle = '#dbe7f3';
      ctx.font = `600 40px ${FONT}`;
      ctx.fillText('Checking…', W / 2, cy);
    } else if (view.phase === 'wrong') {
      ctx.fillStyle = '#ff8b8b';
      ctx.font = `700 40px ${FONT}`;
      ctx.fillText(view.message || 'Not quite.', W / 2, cy - (view.secondsLeft > 0 ? 24 : 0));
      if (view.secondsLeft > 0) {
        ctx.fillStyle = 'rgba(219, 231, 243, 0.8)';
        ctx.font = `500 32px ${FONT}`;
        ctx.fillText(`Try again in ${view.secondsLeft}s`, W / 2, cy + 28);
      }
    } else if (view.phase === 'correct') {
      ctx.fillStyle = '#4fd1a5';
      ctx.font = `700 44px ${FONT}`;
      ctx.fillText(view.message || 'Correct!', W / 2, cy);
    } else {
      ctx.fillStyle = 'rgba(219, 231, 243, 0.7)';
      ctx.font = `500 34px ${FONT}`;
      ctx.fillText('Tap an answer to catch it', W / 2, cy);
    }
    texture.needsUpdate = true;
  }

  const mesh = billboardFrom(canvas, 0.5, 0);
  const texture = (mesh.material as THREE.MeshBasicMaterial).map as THREE.CanvasTexture;
  mesh.renderOrder = 22;

  /** Which option a tap landed on (u, v in 0..1, origin top-left), or -1. */
  function hit(_u: number, v: number) {
    const py = v * H;
    return rects.findIndex((rect) => py >= rect.y && py <= rect.y + rect.h);
  }

  draw({ phase: 'asking', picked: -1, message: '', secondsLeft: 0 });
  return { mesh, draw, hit };
}
