import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminGuard, AuthGuard, AuthedRequest, PlayGuard } from './auth.guard';
import {
  GameError,
  catchSpawn,
  createCode,
  createSpawn,
  deleteSpawn,
  getAccess,
  isAdminEmail,
  listAdminSpawns,
  listCodes,
  listPlaySpawns,
  readSpawnModel,
  redeemCode,
  revokeCode,
  updateSpawn,
  type ModelUpload,
} from './game';
import { r2Configured } from './storage';

type FieldPart = { type: 'field'; fieldname: string; value: string };
type FilePart = {
  type: 'file';
  fieldname: string;
  filename: string;
  mimetype: string;
  toBuffer: () => Promise<Buffer>;
};

function parseDate(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new GameError(`${label} is required.`, 400);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new GameError(`${label} is not a valid date.`, 400);
  return date;
}

function optionalDate(value: unknown) {
  if (value == null || value === '') return null;
  return parseDate(value, 'Expiry');
}

function requiredNumber(value: unknown, label: string) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(number)) throw new GameError(`${label} is required.`, 400);
  return number;
}

async function readForm(request: FastifyRequest) {
  const fields: Record<string, string> = {};
  let file: ModelUpload | null = null;
  const parts = request.parts() as AsyncIterable<FieldPart | FilePart>;
  for await (const part of parts) {
    if (part.type === 'file') {
      const data = await part.toBuffer();
      if (part.filename && data.length) {
        file = { filename: part.filename, mimetype: part.mimetype, data };
      }
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  return { fields, file };
}

@Controller('api')
export class GameController {
  @Get('health')
  health() {
    return {
      ok: true,
      storage: r2Configured() ? 'r2' : 'local',
      google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@Req() request: AuthedRequest) {
    const access = await getAccess(request.user.id);
    return {
      user: request.user,
      isAdmin: isAdminEmail(request.user.email),
      access,
    };
  }

  @Post('codes/redeem')
  @UseGuards(AuthGuard)
  redeem(@Req() request: AuthedRequest, @Body() body: { code?: string }) {
    return redeemCode(request.user.id, body.code ?? '');
  }

  @Get('admin/codes')
  @UseGuards(AuthGuard, AdminGuard)
  codes() {
    return listCodes();
  }

  @Post('admin/codes')
  @UseGuards(AuthGuard, AdminGuard)
  addCode(@Req() request: AuthedRequest, @Body() body: { label?: string; expiresAt?: string; code?: string }) {
    return createCode({
      label: body.label ?? '',
      expiresAt: parseDate(body.expiresAt, 'Expiry'),
      code: body.code,
      createdBy: request.user.id,
    });
  }

  @Post('admin/codes/:id/revoke')
  @UseGuards(AuthGuard, AdminGuard)
  revoke(@Param('id') id: string) {
    return revokeCode(id);
  }

  @Get('spawns')
  @UseGuards(AuthGuard, PlayGuard)
  spawns(@Req() request: AuthedRequest) {
    return listPlaySpawns(request.user.id);
  }

  @Post('spawns/:id/catch')
  @UseGuards(AuthGuard, PlayGuard)
  catch(@Req() request: AuthedRequest, @Param('id') id: string, @Body() body: { latitude?: number; longitude?: number }) {
    return catchSpawn({
      userId: request.user.id,
      spawnId: id,
      latitude: requiredNumber(body.latitude, 'Latitude'),
      longitude: requiredNumber(body.longitude, 'Longitude'),
    });
  }

  @Get('models/:id')
  @UseGuards(AuthGuard, PlayGuard)
  async model(@Param('id') id: string, @Res() reply: FastifyReply) {
    const file = await readSpawnModel(id);
    reply.header('content-type', 'model/gltf-binary');
    reply.header('content-disposition', `inline; filename="${file.filename.replace(/"/g, '')}"`);
    reply.header('cache-control', 'private, max-age=3600');
    reply.send(file.body);
  }

  @Get('admin/spawns')
  @UseGuards(AuthGuard, AdminGuard)
  adminSpawns() {
    return listAdminSpawns();
  }

  @Post('admin/spawns')
  @UseGuards(AuthGuard, AdminGuard)
  async addSpawn(@Req() request: AuthedRequest) {
    const { fields, file } = await readForm(request);
    return createSpawn({
      name: fields.name ?? '',
      summary: fields.summary ?? '',
      latitude: requiredNumber(fields.latitude, 'Latitude'),
      longitude: requiredNumber(fields.longitude, 'Longitude'),
      radiusMeters: requiredNumber(fields.radiusMeters, 'Radius'),
      expiresAt: optionalDate(fields.expiresAt),
      createdBy: request.user.id,
      file,
    });
  }

  @Patch('admin/spawns/:id')
  @UseGuards(AuthGuard, AdminGuard)
  async editSpawn(@Param('id') id: string, @Req() request: FastifyRequest) {
    const type = request.headers['content-type'] ?? '';
    if (type.includes('multipart/form-data')) {
      const { fields, file } = await readForm(request);
      return updateSpawn(id, {
        name: fields.name,
        summary: fields.summary,
        latitude: fields.latitude ? requiredNumber(fields.latitude, 'Latitude') : undefined,
        longitude: fields.longitude ? requiredNumber(fields.longitude, 'Longitude') : undefined,
        radiusMeters: fields.radiusMeters ? requiredNumber(fields.radiusMeters, 'Radius') : undefined,
        expiresAt: fields.expiresAt !== undefined ? optionalDate(fields.expiresAt) : undefined,
        file,
      });
    }
    const body = (request.body ?? {}) as {
      name?: string;
      summary?: string;
      latitude?: number;
      longitude?: number;
      radiusMeters?: number;
      expiresAt?: string | null;
    };
    return updateSpawn(id, {
      name: body.name,
      summary: body.summary,
      latitude: body.latitude,
      longitude: body.longitude,
      radiusMeters: body.radiusMeters,
      expiresAt: body.expiresAt === undefined ? undefined : optionalDate(body.expiresAt),
    });
  }

  @Delete('admin/spawns/:id')
  @UseGuards(AuthGuard, AdminGuard)
  async removeSpawn(@Param('id') id: string) {
    await deleteSpawn(id);
    return { ok: true };
  }
}
