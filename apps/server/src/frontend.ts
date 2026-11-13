import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * In production the API also serves the built frontend, so the whole app is one service on one origin
 * (no CORS, no cross-site cookies). Set FRONTEND_DIST to the frontend's `dist` folder; if it is unset
 * (local development, where Vite serves the app) nothing is registered.
 */
export async function serveFrontend(fastify: FastifyInstance) {
  const root = process.env.FRONTEND_DIST ? path.resolve(process.env.FRONTEND_DIST) : null;
  if (!root || !existsSync(path.join(root, 'index.html'))) return false;

  await fastify.register(fastifyStatic, {
    root,
    wildcard: false,
    index: false,
    // Hashed build files never change; the page itself must always be revalidated.
    setHeaders(res, filePath) {
      const hashed = filePath.split(path.sep).includes('assets');
      res.header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });

  // Any other GET is the single-page app: real files are served as files, anything else gets index.html
  // so deep links like /admin and /login work. Unknown /api paths stay a JSON 404.
  fastify.get('/*', async (request, reply) => {
    const pathname = decodeURIComponent(request.url.split('?')[0]);
    if (pathname.startsWith('/api/')) {
      return reply.code(404).send({ statusCode: 404, message: 'Not found' });
    }
    const last = pathname.split('/').pop() ?? '';
    if (last.includes('.')) {
      const file = path.join(root, pathname);
      if (file.startsWith(root) && existsSync(file)) return reply.sendFile(pathname.replace(/^\/+/, ''));
      return reply.code(404).send({ statusCode: 404, message: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
  return true;
}
