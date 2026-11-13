# Deploying ProteinGo

ProteinGo runs as **one service**: the Nest API also serves the built frontend, so the whole app lives on a
single HTTPS origin (no CORS, no cross-site cookies). The `Dockerfile` builds both parts into one image, so any
host that runs Docker works. `render.yaml` is a ready Render blueprint.

```
phone ──https──▶  [ one service: Nest API + built frontend ]  ──▶ Postgres
```

## Test deployment (what `render.yaml` sets up)

For trying the app from anywhere, with no Google or storage accounts. **The dev sign-in is on**, so anyone who
knows the URL can use `/admin`. Keep the URL to yourself and delete the service when you are done.

One-time setup, about ten minutes (needs a free [Render](https://render.com) account):

1. Render dashboard → **New → Blueprint** → connect your GitHub account → pick this repo and the `main` branch.
2. Render reads `render.yaml` and shows a web service and a database. It asks for one value:
   **`VITE_MAPBOX_TOKEN`**. Paste your Mapbox public token (the same one as in `apps/frontend/.env`).
3. Click **Apply**. The first build takes several minutes. When it finishes, the service shows a URL like
   `https://proteingo-test.onrender.com`.
4. Open it on your phone. On the login page choose **Dev admin** or **Dev student**.

That is all: the database tables are created on start, and the app finds its own URL by itself.

**After that, every push to `main` redeploys automatically.** Watch it under the service's *Events* tab.

### Using it

- Sign in as **Dev admin**, open `/admin`, add a protein (pick a model from the library) **at your location**
  (click the map where you are). Catching is checked on the server, so you have to be inside the protein's
  radius, and at home that means placing the pin at your home.
- Create a class code in `/admin`. Sign out, sign in as **Dev student**, redeem the code, then catch.
- On Android, use Chrome. AR needs HTTPS (Render provides it) and Google Play Services for AR.

### Limits of the free tier

- The service **sleeps after about 15 minutes idle**; the first load after that takes up to a minute.
- The free database **expires after a limited time** (Render's current limit applies). Redeploy the blueprint to
  get a fresh one.
- Uploaded files live on a disk that is wiped on every deploy. Proteins made from **library models** keep
  working because those ship inside the app. A model you upload yourself is lost on the next deploy; to keep
  uploads, configure R2 (see Production).
- Deploys are not instant: a build takes a few minutes, so a push is live a little later.

## Production

For a real class, change the test setup:

| Do | Why |
| --- | --- |
| Remove `DEV_BYPASS_AUTH`, `AUTO_DB_PUSH`, `VITE_ENABLE_DEBUG_TOOLS`, set `NODE_ENV=production` | Real sign-in only; nothing rewrites the database on its own. |
| Set `BETTER_AUTH_URL` and `WEB_ORIGIN` to your public URL if it is not on Render | Render is detected automatically. |
| Add Google sign-in | See below. |
| Add Cloudflare R2 for model storage | Disk is wiped on deploy. |
| Use paid plans | No sleeping, and a database that does not expire. |

### Google sign-in

1. Google Cloud Console → **APIs & Services → OAuth consent screen**. Choose **External** (ucr.edu is not your
   Workspace), add an app name and contact email, then **Publish app**. Basic email/profile sign-in needs no
   Google review; in "Testing" mode only 100 listed users could sign in.
2. **Credentials → Create credentials → OAuth client ID → Web application**.
   - Authorized redirect URI: `https://<your-domain>/api/auth/callback/google`
   - Authorized JavaScript origin: `https://<your-domain>`
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `ADMIN_EMAILS` (comma-separated ucr.edu addresses).

The app only accepts `@ucr.edu` accounts (see `apps/server/src/auth.ts`).

### Model storage (R2)

Create an R2 bucket and an API token with Object Read & Write, then set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY` and `R2_BUCKET`. The bucket stays private; models are served through the API.

### Database tables

With `AUTO_DB_PUSH` off, create or update the tables by hand, from your computer, using the database's
**External** connection string:

```bash
cd apps/server && npm ci
DATABASE_URL="postgres://…" npm run db:push
```

## Running the image yourself

```bash
docker build --build-arg VITE_MAPBOX_TOKEN=pk.… -t proteingo .
docker run -p 3001:3001 --env-file apps/server/.env proteingo
```

Local development is unchanged: `docker compose up -d`, `npm run db:push`, `npm run dev`.

## Notes

- **Model size:** phones refuse models over about 4 million vertices. Use the optimized versions
  (`hemoglobin-sphere-meshopt`, not the `-hq-` one). `apps/frontend/public/ar/scripts` has the optimizer.
- **Mapbox token:** it ends up in the public bundle, so restrict it to your domain in the Mapbox dashboard.
