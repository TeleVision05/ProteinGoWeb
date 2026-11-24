import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminGuard, AuthGuard, AuthedRequest, PlayGuard } from './auth.guard';
import {
  GameError,
  catchAnywhere,
  captureHeatmap,
  catchSpawn,
  createCode,
  createSpawn,
  deleteSpawn,
  getAccess,
  getChallenge,
  getExplored,
  getCollection,
  getLeaderboard,
  getProgress,
  getSettings,
  isAdminEmail,
  listAdminSpawns,
  listCodes,
  listPlaySpawns,
  markExplored,
  readSpawnModel,
  redeemCode,
  revokeCode,
  scatterSpawns,
  updateSettings,
  updateSpawn,
  type ModelFiles,
  type ModelUpload,
  type SettingsInput,
  type Style,
} from './game';
import { devAccountList, devBypassEnabled, devCookie, devUser, isDevRole } from './dev-auth';
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

const FILE_SLOTS = ['sphere', 'sphereLow', 'ribbon', 'ribbonLow'] as const;

async function readForm(request: FastifyRequest) {
  const fields: Record<string, string> = {};
  const files: ModelFiles = {};
  const parts = request.parts() as AsyncIterable<FieldPart | FilePart>;
  for await (const part of parts) {
    if (part.type === 'file') {
      const data = await part.toBuffer();
      if (part.filename && data.length) {
        const upload: ModelUpload = { filename: part.filename, mimetype: part.mimetype, data };
        // `file` is the older single-model field: it is the sphere model.
        const slot = part.fieldname === 'file' ? 'sphere' : (FILE_SLOTS as readonly string[]).includes(part.fieldname) ? part.fieldname : null;
        if (slot) files[slot as keyof ModelFiles] = upload;
      }
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  return { fields, files };
}

function parseStyles(value: unknown): Style[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry): entry is Style => entry === 'sphere' || entry === 'ribbon');
}

@Controller('api')
export class GameController {
  @Get('health')
  health() {
    return {
      ok: true,
      storage: r2Configured() ? 'r2' : 'local',
      google: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      // Only present when DEV_BYPASS_AUTH is on: the login page offers these instead of Google.
      devAccounts: devAccountList(),
    };
  }

  @Post('dev/login')
  async devLogin(
    @Body() body: { role?: string },
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!devBypassEnabled()) throw new GameError('Dev sign-in is off.', 404);
    if (!isDevRole(body.role)) throw new GameError('Pick a dev account.', 400);
    await devUser(body.role); // make sure the row exists
    reply.header('Set-Cookie', devCookie(body.role, request.protocol === 'https'));
    return { ok: true, role: body.role };
  }

  @Post('dev/logout')
  devLogout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header('Set-Cookie', devCookie(null, request.protocol === 'https'));
    return { ok: true };
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@Req() request: AuthedRequest) {
    const access = await getAccess(request.user.id);
    return {
      user: request.user,
      isAdmin: isAdminEmail(request.user.email),
      access,
      catchAnywhere: catchAnywhere(),
      settings: await getSettings(),
    };
  }

  @Get('progress')
  @UseGuards(AuthGuard, PlayGuard)
  progress(@Req() request: AuthedRequest) {
    return getProgress(request.user.id);
  }

  @Get('collection')
  @UseGuards(AuthGuard, PlayGuard)
  collection(@Req() request: AuthedRequest) {
    return getCollection(request.user.id);
  }

  @Get('leaderboard')
  @UseGuards(AuthGuard, PlayGuard)
  leaderboard(@Req() request: AuthedRequest) {
    return getLeaderboard(request.user.id);
  }

  @Get('admin/settings')
  @UseGuards(AuthGuard, AdminGuard)
  settings() {
    return getSettings();
  }

  @Patch('admin/settings')
  @UseGuards(AuthGuard, AdminGuard)
  saveSettings(@Body() body: SettingsInput) {
    return updateSettings({
      leaderboardEnabled: body?.leaderboardEnabled,
      rarityEnabled: body?.rarityEnabled,
      cloudsEnabled: body?.cloudsEnabled,
      cloudDissolveRadius: body?.cloudDissolveRadius,
      cloudHintRadius: body?.cloudHintRadius,
      cloudTransparency: body?.cloudTransparency,
    });
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
  spawns(@Req() request: AuthedRequest, @Query('lat') lat?: string, @Query('lng') lng?: string) {
    // The player's position (optional): with cloud cover on, only proteins near it come back with their real place.
    const latitude = lat === undefined || lat === '' ? NaN : Number(lat);
    const longitude = lng === undefined || lng === '' ? NaN : Number(lng);
    const valid = Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
    return listPlaySpawns(request.user.id, valid ? { latitude, longitude } : null);
  }

  /** The map squares this player has walked through (cloud cover keeps them cleared). */
  @Get('explored')
  @UseGuards(AuthGuard, PlayGuard)
  explored(@Req() request: AuthedRequest) {
    return getExplored(request.user.id);
  }

  @Post('explored')
  @UseGuards(AuthGuard, PlayGuard)
  markExplored(@Req() request: AuthedRequest, @Body() body: { latitude?: number; longitude?: number }) {
    return markExplored(request.user.id, body?.latitude, body?.longitude);
  }

  @Post('spawns/:id/catch')
  @UseGuards(AuthGuard, PlayGuard)
  catch(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
    @Body() body: { latitude?: number; longitude?: number; accuracy?: number; answer?: number },
  ) {
    // With CATCH_ANYWHERE the location is optional (the app may not send one).
    const anywhere = catchAnywhere();
    return catchSpawn({
      userId: request.user.id,
      spawnId: id,
      latitude: anywhere && body.latitude == null ? undefined : requiredNumber(body.latitude, 'Latitude'),
      longitude: anywhere && body.longitude == null ? undefined : requiredNumber(body.longitude, 'Longitude'),
      accuracy: body.accuracy == null ? undefined : requiredNumber(body.accuracy, 'Accuracy'),
      answer: body.answer == null ? undefined : requiredNumber(body.answer, 'Answer'),
    });
  }

  @Get('spawns/:id/challenge')
  @UseGuards(AuthGuard, PlayGuard)
  challenge(@Param('id') id: string) {
    return getChallenge(id);
  }

  @Get('models/:id')
  @UseGuards(AuthGuard, PlayGuard)
  async model(
    @Param('id') id: string,
    @Query('style') style: string | undefined,
    @Query('lod') lod: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const file = await readSpawnModel(id, style, lod);
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
    const { fields, files } = await readForm(request);
    return createSpawn({
      name: fields.name ?? '',
      summary: fields.summary ?? '',
      latitude: requiredNumber(fields.latitude, 'Latitude'),
      longitude: requiredNumber(fields.longitude, 'Longitude'),
      radiusMeters: requiredNumber(fields.radiusMeters, 'Radius'),
      expiresAt: optionalDate(fields.expiresAt),
      createdBy: request.user.id,
      rarity: fields.rarity,
      quiz: fields.quiz,
      files,
    });
  }

  @Post('admin/spawns/scatter')
  @UseGuards(AuthGuard, AdminGuard)
  scatter(
    @Req() request: AuthedRequest,
    @Body()
    body: {
      templateId?: string;
      count?: number;
      centerLatitude?: number;
      centerLongitude?: number;
      areaRadiusMeters?: number;
      namePrefix?: string;
    },
  ) {
    return scatterSpawns({
      templateId: body.templateId ?? '',
      count: requiredNumber(body.count, 'Count'),
      centerLatitude: requiredNumber(body.centerLatitude, 'Latitude'),
      centerLongitude: requiredNumber(body.centerLongitude, 'Longitude'),
      areaRadiusMeters: requiredNumber(body.areaRadiusMeters, 'Area radius'),
      namePrefix: body.namePrefix,
      createdBy: request.user.id,
    });
  }

  @Get('admin/heatmap')
  @UseGuards(AuthGuard, AdminGuard)
  heatmap() {
    return captureHeatmap();
  }

  @Patch('admin/spawns/:id')
  @UseGuards(AuthGuard, AdminGuard)
  async editSpawn(@Param('id') id: string, @Req() request: FastifyRequest) {
    const type = request.headers['content-type'] ?? '';
    if (type.includes('multipart/form-data')) {
      const { fields, files } = await readForm(request);
      return updateSpawn(id, {
        name: fields.name,
        summary: fields.summary,
        latitude: fields.latitude ? requiredNumber(fields.latitude, 'Latitude') : undefined,
        longitude: fields.longitude ? requiredNumber(fields.longitude, 'Longitude') : undefined,
        radiusMeters: fields.radiusMeters ? requiredNumber(fields.radiusMeters, 'Radius') : undefined,
        expiresAt: fields.expiresAt !== undefined ? optionalDate(fields.expiresAt) : undefined,
        rarity: fields.rarity,
        quiz: fields.quiz,
        files,
        removeStyles: parseStyles(fields.removeStyles),
      });
    }
    const body = (request.body ?? {}) as {
      name?: string;
      summary?: string;
      latitude?: number;
      longitude?: number;
      radiusMeters?: number;
      expiresAt?: string | null;
      rarity?: string;
      quiz?: unknown;
      removeStyles?: string;
    };
    return updateSpawn(id, {
      name: body.name,
      summary: body.summary,
      latitude: body.latitude,
      longitude: body.longitude,
      radiusMeters: body.radiusMeters,
      expiresAt: body.expiresAt === undefined ? undefined : optionalDate(body.expiresAt),
      rarity: body.rarity,
      quiz: body.quiz,
      removeStyles: parseStyles(body.removeStyles),
    });
  }

  @Delete('admin/spawns/:id')
  @UseGuards(AuthGuard, AdminGuard)
  async removeSpawn(@Param('id') id: string) {
    await deleteSpawn(id);
    return { ok: true };
  }
}
