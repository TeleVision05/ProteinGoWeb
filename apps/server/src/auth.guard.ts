import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyRequest } from 'fastify';
import { auth } from './auth';
import { GameError, getAccess, isAdminEmail } from './game';

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  image: string | null;
};

export type AuthedRequest = FastifyRequest & { user: SessionUser };

@Injectable()
export class AuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });
    if (!session?.user.email) throw new UnauthorizedException('Sign in with Google.');
    request.user = {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image ?? null,
    };
    return true;
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (!isAdminEmail(request.user.email)) {
      throw new GameError('Admin access is limited to the allowlist.', 403);
    }
    return true;
  }
}

@Injectable()
export class PlayGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (isAdminEmail(request.user.email)) return true;
    const access = await getAccess(request.user.id);
    if (!access.active) throw new GameError('Enter a current class code to play.', 403);
    return true;
  }
}
