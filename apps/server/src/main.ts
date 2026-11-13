import 'dotenv/config';
import 'reflect-metadata';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppModule } from './app.module';
import { handleAuthRequest } from './auth.controller';
import { GameErrorFilter } from './game-error.filter';
import { serveFrontend } from './frontend';
import { webOrigin } from './public-url';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
  );
  await app.register(cors, {
    origin: webOrigin(),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(multipart, {
    limits: { fileSize: 120 * 1024 * 1024 },
  });
  app.useGlobalFilters(new GameErrorFilter());
  const fastify = app.getHttpAdapter().getInstance();
  fastify.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: (request: FastifyRequest, reply: FastifyReply) => handleAuthRequest(request, reply),
  });
  await serveFrontend(fastify);
  await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
}

void bootstrap();
