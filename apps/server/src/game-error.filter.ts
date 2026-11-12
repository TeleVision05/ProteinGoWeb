import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { GameError } from './game';

@Catch(GameError)
export class GameErrorFilter implements ExceptionFilter {
  catch(error: GameError, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    reply.status(error.status).send({
      statusCode: error.status,
      message: error.message,
    });
  }
}
