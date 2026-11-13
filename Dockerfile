# One service: the Nest API also serves the built frontend, so the app has a single origin.
#
#   docker build --build-arg VITE_MAPBOX_TOKEN=pk.... -t proteingo .
#   docker run -p 3001:3001 --env-file apps/server/.env -e NODE_ENV=production proteingo

# ---- 1. Build the frontend ----------------------------------------------------------------------
FROM node:22-slim AS web
WORKDIR /app/apps/frontend
COPY apps/frontend/package.json apps/frontend/package-lock.json ./
RUN npm ci
COPY apps/frontend ./
# Vite bakes VITE_* values into the bundle at build time.
ARG VITE_MAPBOX_TOKEN
ARG VITE_ENABLE_DEBUG_TOOLS
ENV VITE_MAPBOX_TOKEN=$VITE_MAPBOX_TOKEN
ENV VITE_ENABLE_DEBUG_TOOLS=$VITE_ENABLE_DEBUG_TOOLS
RUN npm run build

# ---- 2. Build the API ---------------------------------------------------------------------------
FROM node:22-slim AS api
WORKDIR /app/apps/server
COPY apps/server/package.json apps/server/package-lock.json ./
RUN npm ci
COPY apps/server ./
RUN npm run build && npm prune --omit=dev

# ---- 3. Run ---------------------------------------------------------------------------------------
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app/apps/server
COPY --from=api /app/apps/server/package.json ./
COPY --from=api /app/apps/server/node_modules ./node_modules
COPY --from=api /app/apps/server/dist ./dist
# drizzle-kit and the schema, so AUTO_DB_PUSH=true can create the tables on startup (test deployments).
COPY --from=api /app/apps/server/drizzle.config.ts ./
COPY --from=api /app/apps/server/src/db ./src/db
COPY --from=web /app/apps/frontend/dist /app/apps/frontend/dist
ENV FRONTEND_DIST=/app/apps/frontend/dist
EXPOSE 3001
# Hosts such as Render set PORT; the server falls back to 3001.
# With AUTO_DB_PUSH=true the database tables are created/updated first. Leave it off for anything real:
# a push can change or drop columns, so run it by hand for production.
CMD ["sh", "-c", "if [ \"$AUTO_DB_PUSH\" = \"true\" ]; then npx --no-install drizzle-kit push --force || echo 'db push failed, continuing'; fi; exec node dist/main.js"]
