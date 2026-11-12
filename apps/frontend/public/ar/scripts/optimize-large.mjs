// Meshopt-optimizes GLBs larger than 2 GiB, which the gltf-transform CLI can't read
// (Node's fs.readFile caps at 2 GiB). Reads in chunks and runs the same steps as
// `gltf-transform optimize --compress meshopt --simplify false`.
//
// Usage: node --max-old-space-size=24000 scripts/optimize-large.mjs <in.glb> <out.glb>
import { closeSync, openSync, readSync, fstatSync, writeSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, flatten, instance, join, meshopt, palette, prune, resample, sparse, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: node scripts/optimize-large.mjs <in.glb> <out.glb>');
  process.exit(1);
}

const CHUNK = 1 << 30;
const t0 = Date.now();
const log = (msg) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

function readLarge(path) {
  const fd = openSync(path, 'r');
  const { size } = fstatSync(fd);
  const buf = Buffer.allocUnsafe(size);
  for (let off = 0; off < size;) off += readSync(fd, buf, off, Math.min(CHUNK, size - off), off);
  closeSync(fd);
  return new Uint8Array(buf.buffer, buf.byteOffset, size);
}

function writeLarge(path, data) {
  const fd = openSync(path, 'w');
  for (let off = 0; off < data.byteLength;) off += writeSync(fd, data, off, Math.min(CHUNK, data.byteLength - off));
  closeSync(fd);
}

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

log(`reading ${input}`);
const doc = await io.readBinary(readLarge(input));
log('read; optimizing');
await doc.transform(
  dedup(),
  instance({ min: 5 }),
  palette({ min: 5 }),
  flatten(),
  join(),
  weld(),
  resample(),
  prune({ keepAttributes: false }),
  sparse(),
  meshopt({ encoder: MeshoptEncoder, level: 'high' }),
);
log('writing');
const out = await io.writeBinary(doc);
writeLarge(output, out);
log(`info: ${input} -> ${output} (${(out.byteLength / 1048576).toFixed(1)} MB)`);
