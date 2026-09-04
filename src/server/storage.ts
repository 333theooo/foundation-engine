import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { serverEnv } from './env';
import { logger } from './logger';

/**
 * Object storage behind one interface.
 *
 * `local` writes under a configured directory and needs no credentials, so a
 * developer can clone the repo and import an IFC file in the first five
 * minutes. `s3` speaks to any S3-compatible service. Both drivers are the real
 * implementation - neither is a stub, and switching is a single env variable.
 *
 * Storage keys are always generated here. A client-supplied filename is kept
 * only as display metadata; it never reaches the filesystem or the bucket path,
 * which is what makes path traversal impossible rather than merely unlikely.
 */

export interface StoredObject {
  key: string;
  size: number;
  checksum: string;
}

export interface StorageDriver {
  readonly kind: 's3' | 'local';
  put(key: string, body: Uint8Array, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
}

/**
 * Storage keys: lowercase, slash-separated, with a single dot before the
 * extension. Traversal is blocked separately in `assertSafeKey`, because `..`
 * is otherwise spelled with characters this class allows.
 */
const SAFE_KEY = /^[a-z0-9][a-z0-9/_.-]{0,199}$/;

/** ASCII control characters, built from escapes so the source stays printable. */
const CONTROL_CHARACTERS = new RegExp('[\\u0000-\\u001F\\u007F]', 'g');

/**
 * Builds a storage key from a namespace and an opaque random id.
 * The user's filename is deliberately not part of it.
 */
export function createStorageKey(namespace: string, ownerId: string, extension: string): string {
  const cleanNamespace = namespace.replace(/[^a-z0-9-]/g, '').slice(0, 32) || 'object';
  const cleanOwner = ownerId
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 32)
    .toLowerCase();
  const cleanExtension = extension
    .replace(/[^a-z0-9]/gi, '')
    .slice(0, 8)
    .toLowerCase();
  const id = randomBytes(16).toString('hex');
  const key = `${cleanNamespace}/${cleanOwner}/${id}${cleanExtension ? `.${cleanExtension}` : ''}`;
  if (!SAFE_KEY.test(key)) {
    throw new Error('Generated an unsafe storage key; refusing to continue.');
  }
  return key;
}

export function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes('..')) {
    throw new Error(`Refusing to use storage key "${key}".`);
  }
}

class LocalStorage implements StorageDriver {
  readonly kind = 'local' as const;
  private readonly root: string;

  constructor(directory: string) {
    // turbopackIgnore keeps the bundler from tracing the whole project into the
    // server output: the path is a runtime configuration value, and the local
    // driver only ever reads and writes inside the directory it names.
    this.root = resolve(/* turbopackIgnore: true */ process.cwd(), directory);
  }

  private pathFor(key: string): string {
    assertSafeKey(key);
    const full = resolve(join(this.root, key));
    // Belt and braces: even with a validated key, never escape the root.
    if (!full.startsWith(this.root)) throw new Error('Storage path escaped the storage root.');
    return full;
  }

  async put(key: string, body: Uint8Array, _contentType: string): Promise<StoredObject> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return {
      key,
      size: body.byteLength,
      checksum: createHash('sha256').update(body).digest('hex'),
    };
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(this.pathFor(key)));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

class S3Storage implements StorageDriver {
  readonly kind = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    const env = serverEnv();
    this.bucket = env.S3_BUCKET!;
    this.client = new S3Client({
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID!,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
      },
    });
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<StoredObject> {
    assertSafeKey(key);
    const checksum = createHash('sha256').update(body).digest('hex');
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        Metadata: { sha256: checksum },
      }),
    );
    return { key, size: body.byteLength, checksum };
  }

  async get(key: string): Promise<Uint8Array> {
    assertSafeKey(key);
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) throw new Error(`Object "${key}" is empty or unreadable.`);
    return bytes;
  }

  async delete(key: string): Promise<void> {
    assertSafeKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let driver: StorageDriver | null = null;

export function storage(): StorageDriver {
  if (!driver) {
    const env = serverEnv();
    driver =
      env.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage(env.LOCAL_STORAGE_DIR);
    logger().info({ driver: driver.kind }, 'storage driver initialised');
  }
  return driver;
}

/** Test seam: lets integration tests swap in an in-memory driver. */
export function setStorageDriver(next: StorageDriver | null): void {
  driver = next;
}

/** Extension allowlist per upload purpose. Content is validated separately. */
export const ALLOWED_MODEL_EXTENSIONS = [
  'gltf',
  'glb',
  'obj',
  'stl',
  'ifc',
  'dxf',
  'json',
] as const;
export const ALLOWED_DOCUMENT_EXTENSIONS = ['txt', 'md', 'markdown', 'csv', 'json'] as const;

export function extensionOf(filename: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(filename.trim());
  return match?.[1]?.toLowerCase() ?? '';
}

/**
 * Filename shown in the UI. Strips directory components and control characters
 * so a hostile name cannot break out of a log line or a download header.
 */
export function displayFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(CONTROL_CHARACTERS, '').trim();
  return cleaned.slice(0, 200) || 'upload';
}
