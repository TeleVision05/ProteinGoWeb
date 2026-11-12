// Usage: npm run add-model -- <file.glb> [display-name] [--meshopt-only]
//
// Links (or copies) the source GLB into models/src/, writes meshopt (+ Draco) optimized variants,
// and registers them in the model lists:
//   models/models.json        committed + deployed (files under GitHub's 100 MB limit)
//   models/models.local.json  local server only (originals and anything too big to push)
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const args = process.argv.slice(2);
const meshoptOnly = args.includes('--meshopt-only');
const [input, nameArg] = args.filter((a) => !a.startsWith('--'));
if (!input) {
  console.error('Usage: npm run add-model -- <file.glb> [display-name] [--meshopt-only]');
  process.exit(1);
}

const DEPLOY_LIMIT = 95 * 1024 * 1024;
const root = resolve(import.meta.dirname, '..');
const title = nameArg || basename(input, extname(input));
const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const abs = (p) => join(root, p);
for (const d of ['models/src', 'models/local']) mkdirSync(abs(d), { recursive: true });

// Hard link instead of copying multi-GB sources when on the same volume.
const src = `models/src/${slug}.glb`;
if (existsSync(abs(src))) unlinkSync(abs(src));
try { linkSync(resolve(input), abs(src)); } catch { copyFileSync(resolve(input), abs(src)); }

const cli = abs('node_modules/@gltf-transform/cli/bin/cli.js');
const variants = [{ suffix: 'meshopt', label: 'meshopt+quantized', args: ['--compress', 'meshopt'] }];
if (!meshoptOnly) variants.push({ suffix: 'draco', label: 'Draco', args: ['--compress', 'draco'] });

const mb = (p) => `${(statSync(abs(p)).size / 1048576).toFixed(1)} MB`;
const deployed = [], local = [];
for (const v of variants) {
  let out = `models/${slug}-${v.suffix}.glb`;
  for (const old of [out, `models/local/${slug}-${v.suffix}.glb`]) if (existsSync(abs(old))) unlinkSync(abs(old));
  if (statSync(abs(src)).size >= 2 ** 31) {
    // The CLI can't read files over 2 GiB; this script reads in chunks (meshopt only).
    if (v.suffix !== 'meshopt') continue;
    execFileSync(process.execPath, ['--max-old-space-size=28000', abs('scripts/optimize-large.mjs'), src, out],
      { cwd: root, stdio: 'inherit' });
  } else {
    // --simplify false keeps full detail; --texture-compress ktx2 needs the KTX-Software CLI, so webp by default.
    execFileSync(process.execPath, ['--max-old-space-size=24000', cli, 'optimize', src, out, ...v.args,
      '--simplify', 'false', '--texture-compress', 'webp'], { cwd: root, stdio: 'inherit' });
  }
  if (statSync(abs(out)).size > DEPLOY_LIMIT) {
    const moved = `models/local/${slug}-${v.suffix}.glb`;
    renameSync(abs(out), abs(moved));
    out = moved;
    local.push({ name: `${title} · ${v.label} (${mb(out)})`, url: out });
  } else {
    deployed.push({ name: `${title} · ${v.label} (${mb(out)})`, url: out });
  }
}
local.push({ name: `${title} · original (${mb(src)})`, url: src });

const update = (file, entries) => {
  const p = abs(file);
  const list = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
  // Drop any previous entries for this model (it may have moved between the deployed and local lists).
  const mine = new Set([src, ...['meshopt', 'draco'].flatMap((s) => [`models/${slug}-${s}.glb`, `models/local/${slug}-${s}.glb`])]);
  const kept = list.filter((m) => !mine.has(m.url));
  writeFileSync(p, `${JSON.stringify([...kept, ...entries], null, 2)}\n`);
};
update('models/models.json', deployed);
update('models/models.local.json', local);
console.log(`Added ${title}: ${deployed.length} deployable, ${local.length} local-only`);
