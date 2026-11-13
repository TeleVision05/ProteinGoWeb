import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function r2Configured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET,
  );
}

function client() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    },
  });
}

function localPath(key: string) {
  const root = path.resolve(process.cwd(), 'uploads');
  const full = path.resolve(root, key);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('Model key escapes the upload directory.');
  }
  return full;
}

export async function putModel(key: string, body: Buffer, contentType: string) {
  if (r2Configured()) {
    await client().send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return;
  }
  const full = localPath(key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, body);
}

export async function readModel(key: string) {
  if (r2Configured()) {
    const out = await client().send(
      new GetObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      }),
    );
    if (!out.Body) return null;
    const bytes = await out.Body.transformToByteArray();
    return Buffer.from(bytes);
  }
  try {
    return await readFile(localPath(key));
  } catch {
    return null;
  }
}

/**
 * Library models ship inside the app (frontend/ar/models), so a protein made from one still has its model after
 * a redeploy even when uploads live on a disk that gets wiped. Only plain .glb names, never paths.
 */
export async function readBundledModel(filename: string | null) {
  const dist = process.env.FRONTEND_DIST;
  const name = filename ? path.basename(filename) : '';
  if (!dist || !name.toLowerCase().endsWith('.glb')) return null;
  try {
    return await readFile(path.join(path.resolve(dist), 'ar', 'models', name));
  } catch {
    return null;
  }
}

export async function deleteModel(key: string) {
  if (r2Configured()) {
    await client().send(
      new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      }),
    );
    return;
  }
  await rm(localPath(key), { force: true });
}
