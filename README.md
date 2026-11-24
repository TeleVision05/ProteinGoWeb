# ProteinGo

A campus augmented-reality game for UC Riverside. Proteins appear on a map around campus; players walk to one,
answer a quiz question, and catch it in AR (or in a 3D viewer on devices without AR). Catches earn XP, levels,
streaks and achievements, and fill a personal collection.

## Features

**Players**
- Map of nearby proteins, colored by rarity, with a "nearest protein" chip.
- Catch flow in AR (WebXR): the quiz question and answers appear on an in-world panel, then the protein can be
  inspected. Devices without WebXR get the same experience in a 3D viewer.
- The protein stands on a pedestal. A screen slides out of the pedestal's front (tap the pedestal to hide or show it)
  with the controls: a ribbon/spheres switch for proteins that have both, and animation play, restart, speed and scrub.
  Models switch level of detail (LOD) by distance.
- Collection page, XP bar, levels, daily streaks, 10 achievements, and an optional leaderboard.
- **Assignments** page: the proteins the instructor requires, progress through them, and, once every one is caught, a
  personal completion code to hand in (plus a note if it was after the due date).

**Admins** (`/admin`)
- Add, edit, move and delete proteins; pick models from the library or upload your own (sphere/ribbon, each with
  an optional low-detail LOD).
- Quiz question, rarity and catch radius per protein; scatter many proteins across an area at once.
- Map layers (catch heatmap, coverage), filters, class access codes.
- **Assignments**: pick the required proteins and an optional due date. The due date only marks a finish as late; it
  never blocks play.
- **Roster**: every student with proteins caught, XP, first-try and wrong quiz answers, and per assignment whether they
  are done, when, and their completion code (so a handed-in code can be checked). Download it as CSV. A question table
  lists the questions with the most wrong answers and the most common wrong answer.
- Settings: turn the leaderboard and rarity levels on or off, and **Dynamic cloud cover**: clouds cover the players' whole
  map and dissolve in a soft-edged circle around them as they walk, and the ground they have walked through stays cleared
  (kept on the server as 25 m squares, only while cloud cover is on). Proteins outside the cleared ground are hidden (the
  server only sends their real place when a player is near or has explored there), and a large, gradual glow in the
  protein's color shows roughly where one is. Dissolve radius, hint radius and cloud transparency are adjustable.

**Quiz answers** are stored (right and wrong), which keeps the retry cool-down across server restarts and feeds the
roster's question table.

**Anti-cheat**: catch rate limit, GPS accuracy limit, impossible-travel check, and a cooldown after a wrong answer.

## Stack

| Part | Tech |
| --- | --- |
| `apps/server` | NestJS + Fastify, Drizzle ORM, PostgreSQL, better-auth (Google sign-in), Cloudflare R2 or local disk for models |
| `apps/frontend` | Vite, React 19, Tailwind 4, three.js (WebXR), Mapbox GL |

In production the API also serves the built frontend, so the whole app runs as one service on one origin.

## Quick start

Requirements: Node 22, Docker (for Postgres), and a [Mapbox](https://www.mapbox.com) public token.

```bash
npm install
npm install --prefix apps/server
npm install --prefix apps/frontend

cp apps/server/.env.example apps/server/.env       # then fill it in
cp apps/frontend/.env.example apps/frontend/.env   # add VITE_MAPBOX_TOKEN

npm run dev            # starts Postgres, creates the tables, then the API and the web app
npm run dev -- --seed  # same, and also loads demo proteins, players and a class code
```

Open http://localhost:5173. For local work without Google credentials, set `DEV_BYPASS_AUTH=true` in
`apps/server/.env` and pick **Dev admin** or **Dev student** on the login page. The API listens on port 3001.

Testing AR needs HTTPS and a phone; see [DEPLOY.md](DEPLOY.md) for a hosted test deployment.

### Demo data

`npm run seed` fills the database with seven proteins around campus (with models, quizzes and rarities), four
fake players, the leaderboard turned on, and the class code `DEMO2026`. It is safe to run again.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | One-command dev: Docker Postgres, `db:push`, API and web app (`--seed` to add demo data) |
| `npm run db:up` / `db:push` | Start Postgres / create or update the tables |
| `npm run seed` | Load demo data |
| `npm test` | Server tests (needs the dev database running) |
| `npm run typecheck` | Type-check the server and build the frontend |

CI (`.github/workflows/ci.yml`) runs the typecheck, tests and builds on every pull request.

## Configuration

Server settings live in `apps/server/.env` (see `.env.example`):

- `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `WEB_ORIGIN`
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: Google sign-in, restricted to ucr.edu accounts
- `ADMIN_EMAILS`: comma-separated addresses that can open `/admin`
- `R2_*`: Cloudflare R2 for model storage; leave blank to store files on local disk (`apps/server/uploads`)
- `DEV_BYPASS_AUTH`, `DEV_BYPASS_EMAIL`, `DEV_STUDENT_EMAIL`: dev sign-in (refused when `NODE_ENV=production`)
- `CATCH_ANYWHERE`: temporary switch that skips the location check

`DEV_BYPASS_AUTH` and `CATCH_ANYWHERE` exist for testing. Turn them off, and remove them from the deployment,
before a real launch.

Frontend settings live in `apps/frontend/.env`: `VITE_MAPBOX_TOKEN` and optionally `VITE_API_URL`.

## Game rules

- XP per catch by rarity: common 10, uncommon 25, rare 50, legendary 100. Answering the quiz correctly on the
  first try adds a 50% bonus.
- Level *n* begins at 50·(n−1)² XP.
- Streaks count consecutive UTC days with at least one catch.
- With rarity levels switched off in admin settings, every protein is treated as common.

## Models

Library models live in `apps/frontend/public/ar/models/` and are listed in `models.json`. File names follow
`<group>-<sphere|ribbon>[-lod1]-<meshopt|draco>.glb`; a group with both styles shows the ribbon/sphere switch.

- `node apps/frontend/public/ar/scripts/add-model.mjs`: add a model to the library
- `node apps/frontend/public/ar/scripts/make-lod.mjs`: generate a low-detail LOD from a full model

## Deployment

`Dockerfile` builds one image with the API and the frontend. `render.yaml` is a Render blueprint for a free-tier
test deployment, and [DEPLOY.md](DEPLOY.md) covers it plus a production checklist. Render deploys of this
service are currently manual (Manual Deploy → Deploy latest commit) because Auto-Deploy is off.

## Project layout

```
apps/
  server/    NestJS API (game.ts: spawns, catches, settings; progress.ts: XP and levels; tests/)
  frontend/  React app (pages/, components/, ar/ for the three.js viewer)
scripts/     dev.mjs: the one-command dev runner
```
