import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { auth } from './auth';

export async function handleAuthRequest(request: FastifyRequest, reply: FastifyReply) {
    const host = request.headers.host ?? 'localhost:3001';
    const forwarded = request.headers['x-forwarded-proto'];
    const protocol = (Array.isArray(forwarded) ? forwarded[0] : forwarded) ?? request.protocol ?? 'http';
    const url = new URL(request.url, `${protocol}://${host}`);
    const headers = fromNodeHeaders(request.headers);
    headers.delete('content-length');
    headers.delete('transfer-encoding');
    const method = request.method.toUpperCase();
    const bodyAllowed = method !== 'GET' && method !== 'HEAD';
    const body =
      bodyAllowed && request.body != null
        ? typeof request.body === 'string'
          ? request.body
          : JSON.stringify(request.body)
        : undefined;

    const response = await auth.handler(new Request(url.toString(), { method, headers, body }));
    reply.status(response.status);
    const cookies = response.headers.getSetCookie();
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === 'set-cookie' || lower === 'content-length' || lower === 'transfer-encoding') return;
      reply.header(key, value);
    });
    if (cookies.length) reply.header('set-cookie', cookies);
    const text = response.body ? await response.text() : null;
    reply.send(text);
}
