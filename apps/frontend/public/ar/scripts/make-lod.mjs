// Usage: node scripts/make-lod.mjs <in.glb> <out.glb> [--codec meshopt|draco] [--ratio 0.2] [--error 0.05]
//
// Writes a low-detail (LOD 1) copy of a GLB: welds, simplifies with meshoptimizer, prunes, then re-compresses.
// Reads meshopt- or Draco-compressed inputs. Prints before/after vertex and triangle counts.
//
// Needs @gltf-transform/{core,extensions,functions}, meshoptimizer and draco3dgltf. They resolve from
// ./node_modules (npm install here) or from the folder named by the GLTF_TOOLS env var.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const req = createRequire(resolve(process.env.GLTF_TOOLS ?? root, 'noop.js'));
const { NodeIO } = req('@gltf-transform/core');
const { ALL_EXTENSIONS } = req('@gltf-transform/extensions');
const { weld, simplify, prune, dedup, meshopt, draco } = req('@gltf-transform/functions');
const { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } = req('meshoptimizer');
const draco3d = req('draco3dgltf');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const [input, output] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!input || !output) {
  console.error('Usage: node scripts/make-lod.mjs <in.glb> <out.glb> [--codec meshopt|draco] [--ratio 0.2] [--error 0.05]');
  process.exit(1);
}
const codec = opt('codec', 'meshopt');
const ratio = Number(opt('ratio', '0.2'));
const error = Number(opt('error', '0.05'));

await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.decoder': MeshoptDecoder,
  'meshopt.encoder': MeshoptEncoder,
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

function counts(doc) {
  let vertices = 0, triangles = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      vertices += prim.getAttribute('POSITION')?.getCount() ?? 0;
      triangles += (prim.getIndices()?.getCount() ?? 0) / 3;
    }
  }
  return { vertices, triangles: Math.round(triangles) };
}

// Area-weighted smooth vertex normals (float32). gltf-transform's own normals() makes flat ones and unwelds.
function smoothNormals() {
  return (document) => {
    const buffer = document.getRoot().listBuffers()[0];
    for (const mesh of document.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        const idx = prim.getIndices();
        if (!pos || !idx || prim.getMode() !== 4) continue;
        const n = pos.getCount();
        const p = new Float32Array(n * 3);
        const v = [0, 0, 0];
        for (let i = 0; i < n; i++) { pos.getElement(i, v); p.set(v, i * 3); }
        const acc = new Float32Array(n * 3);
        const ia = idx.getArray();
        for (let t = 0; t < ia.length; t += 3) {
          const a = ia[t] * 3, b = ia[t + 1] * 3, c = ia[t + 2] * 3;
          const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
          const wx = p[c] - p[a], wy = p[c + 1] - p[a + 1], wz = p[c + 2] - p[a + 2];
          const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
          for (const k of [a, b, c]) { acc[k] += nx; acc[k + 1] += ny; acc[k + 2] += nz; }
        }
        for (let i = 0; i < n; i++) {
          const k = i * 3, len = Math.hypot(acc[k], acc[k + 1], acc[k + 2]) || 1;
          acc[k] /= len; acc[k + 1] /= len; acc[k + 2] /= len;
        }
        prim.setAttribute('NORMAL', document.createAccessor().setType('VEC3').setArray(acc).setBuffer(buffer));
      }
    }
  };
}

const doc = await io.read(input);
const before = counts(doc);
// Flat-shaded sources repeat every vertex once per face (a different normal each time), so no two faces share an
// edge and nothing can collapse. Drop the normals, weld by position/colour, simplify, then rebuild smooth normals.
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) prim.setAttribute('NORMAL', null);
}
await doc.transform(
  dedup(),
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio, error }),
  smoothNormals(),
  prune(),
  codec === 'draco' ? draco() : meshopt({ encoder: MeshoptEncoder, level: 'high' }),
);
await io.write(output, doc);
const after = counts(await io.read(output));
console.log(JSON.stringify({ input, output, codec, before, after }));
