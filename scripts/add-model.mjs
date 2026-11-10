// Usage: npm run add-model -- "path/to/model.glb" [short-name]
// Copies the source GLB into models/src/, writes meshopt + Draco optimized variants,
// and registers all three in models/models.json so they show up in the viewer.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';

const [input, nameArg] = process.argv.slice(2);
if (!input) {
  console.error('Usage: npm run add-model -- <file.glb> [short-name]');
  process.exit(1);
}

const root = resolve(import.meta.dirname, '..');
const slug = (nameArg || basename(input, extname(input))).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const src = join('models', 'src', `${slug}.glb`);
mkdirSync(join(root, 'models', 'src'), { recursive: true });
copyFileSync(resolve(input), join(root, src));

const cli = join(root, 'node_modules', '@gltf-transform', 'cli', 'bin', 'cli.js');
const variants = [
  { file: `models/${slug}-meshopt.glb`, label: 'meshopt+quantized', args: ['--compress', 'meshopt'] },
  { file: `models/${slug}-draco.glb`, label: 'Draco', args: ['--compress', 'draco'] },
];
for (const v of variants) {
  // --simplify false keeps full detail; --texture-compress ktx2 needs the KTX-Software CLI, so webp by default.
  execFileSync(process.execPath, [cli, 'optimize', src, v.file, ...v.args, '--simplify', 'false', '--texture-compress', 'webp'],
    { cwd: root, stdio: 'inherit' });
}

const mb = (f) => `${(statSync(join(root, f)).size / 1048576).toFixed(1)} MB`;
const listPath = join(root, 'models', 'models.json');
const list = JSON.parse(readFileSync(listPath, 'utf8')).filter((m) => !m.url.includes(`/${slug}`));
const title = nameArg || basename(input, extname(input));
list.push(
  ...variants.map((v) => ({ name: `${title} · ${v.label} (${mb(v.file)})`, url: v.file })),
  { name: `${title} · original (${mb(src)})`, url: src.replaceAll('\\', '/') },
);
writeFileSync(listPath, `${JSON.stringify(list, null, 2)}\n`);
console.log(`Added ${title} to models/models.json`);
