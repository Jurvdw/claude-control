import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { randomToken } from './crypto.js';

// Storage abstraction: local disk (dev) or S3-compatible (prod, seam).
// Keys are opaque; the driver resolves them to a backing location.

export interface StorageDriver {
  put(buffer: Buffer, opts: { ext?: string; contentType?: string }): Promise<string>; // returns key
  get(key: string): Promise<Buffer>;
  url(key: string): string;
}

class LocalStorage implements StorageDriver {
  private root = path.resolve(env.STORAGE_LOCAL_DIR);

  async put(buffer: Buffer, opts: { ext?: string } = {}): Promise<string> {
    const key = `${randomToken(8)}${opts.ext ? '.' + opts.ext.replace(/^\./, '') : ''}`;
    await fs.mkdir(this.root, { recursive: true });
    await fs.writeFile(path.join(this.root, key), buffer);
    return key;
  }

  async get(key: string): Promise<Buffer> {
    // Guard against path traversal — key must be a bare filename.
    if (key.includes('/') || key.includes('\\') || key.includes('..')) {
      throw new Error('invalid storage key');
    }
    return fs.readFile(path.join(this.root, key));
  }

  url(key: string): string {
    return `${env.API_URL}/files/raw/${encodeURIComponent(key)}`;
  }
}

// S3 seam — implement with @aws-sdk/client-s3 when STORAGE_DRIVER=s3.
class S3Storage implements StorageDriver {
  async put(): Promise<string> {
    throw new Error('S3 storage driver not yet implemented — set STORAGE_DRIVER=local.');
  }
  async get(): Promise<Buffer> {
    throw new Error('S3 storage driver not yet implemented.');
  }
  url(key: string): string {
    return `${env.S3_ENDPOINT}/${env.S3_BUCKET}/${key}`;
  }
}

export const storage: StorageDriver =
  env.STORAGE_DRIVER === 's3' ? new S3Storage() : new LocalStorage();
