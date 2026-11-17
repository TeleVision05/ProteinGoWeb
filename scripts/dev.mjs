// One command to start everything for local development:
//
//   npm run dev            starts Docker (if needed), Postgres, the schema, then the API and the web app
//   npm run dev -- --seed  also fills the database with sample proteins and players first
//
// It is safe to run repeatedly: every step is skipped when it is already done.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wantSeed = process.argv.includes('--seed');
const windows = process.platform === 'win32';
const npm = windows ? 'npm.cmd' : 'npm';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (text) => console.log(`\x1b[36m[dev]\x1b[0m ${text}`);

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: windows, ...options });
}

function quiet(command, args) {
  return spawnSync(command, args, { cwd: root, stdio: 'ignore', shell: windows }).status === 0;
}

function fail(message) {
  console.error(`\x1b[31m[dev]\x1b[0m ${message}`);
  process.exit(1);
}

async function waitFor(label, check, seconds) {
  const stop = Date.now() + seconds * 1000;
  while (Date.now() < stop) {
    if (check()) return;
    await sleep(2000);
  }
  fail(`${label} did not come up within ${seconds}s.`);
}

// 1. Dependencies
for (const dir of ['.', 'apps/server', 'apps/frontend']) {
  if (!existsSync(path.join(root, dir, 'node_modules'))) {
    say(`Installing packages in ${dir}…`);
    if (run(npm, ['install'], { cwd: path.join(root, dir) }).status !== 0) fail(`npm install failed in ${dir}.`);
  }
}

// 2. .env
if (!existsSync(path.join(root, 'apps/server/.env'))) {
  fail('apps/server/.env is missing. Copy apps/server/.env.example to apps/server/.env and fill it in.');
}

// 3. Docker
if (!quiet('docker', ['info'])) {
  say('Docker is not running. Starting it…');
  if (windows) {
    const exe = 'C:\Program Files\Docker\Docker\Docker Desktop.exe';
    if (!existsSync(exe)) fail('Docker Desktop is not installed. Install it from https://www.docker.com/products/docker-desktop/');
    spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    run('open', ['-a', 'Docker']);
  } else {
    fail('Start the Docker daemon (for example: sudo systemctl start docker), then run this again.');
  }
  await waitFor('Docker', () => quiet('docker', ['info']), 240);
}

// 4. Postgres
say('Starting Postgres…');
if (run('docker', ['compose', 'up', '-d']).status !== 0) fail('docker compose up failed.');
await waitFor('Postgres', () => quiet('docker', ['compose', 'exec', '-T', 'postgres', 'pg_isready', '-U', 'proteingo']), 90);

// 5. Tables
say('Updating database tables…');
if (run(npm, ['run', 'db:push']).status !== 0) fail('db:push failed.');

// 6. Sample data
if (wantSeed) {
  say('Seeding sample data…');
  if (run(npm, ['run', 'seed']).status !== 0) fail('Seeding failed.');
} else {
  say('Tip: run `npm run dev -- --seed` once to add sample proteins, players and the class code DEMO2026.');
}

// 7. The apps
say('Starting the API (3001) and web app (5173)…');
const child = spawn(npm, ['run', 'dev:apps'], { cwd: root, stdio: 'inherit', shell: windows });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
