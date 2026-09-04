import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStorageKey, setStorageDriver, storage, type StorageDriver } from '@/server/storage';

/**
 * The local storage driver, exercised against the real filesystem.
 *
 * This is the driver a developer and a self-hosted deployment actually use, so
 * testing it against a mock would prove nothing. The test directory is removed
 * afterwards.
 */

const TEST_DIR = './storage/test';

beforeAll(() => {
  setStorageDriver(null);
});

afterAll(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  setStorageDriver(null);
});

describe('local storage driver', () => {
  it('round-trips bytes exactly', async () => {
    const driver = storage();
    expect(driver.kind).toBe('local');

    const key = createStorageKey('imports', 'user1', 'ifc');
    const payload = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const stored = await driver.put(key, payload, 'application/octet-stream');

    expect(stored.size).toBe(payload.byteLength);
    expect(stored.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(Array.from(await driver.get(key))).toEqual(Array.from(payload));
  });

  it('handles a large binary payload', async () => {
    const driver = storage();
    const key = createStorageKey('imports', 'user1', 'glb');
    const payload = new Uint8Array(2 * 1024 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 256;

    await driver.put(key, payload, 'model/gltf-binary');
    const read = await driver.get(key);
    expect(read.byteLength).toBe(payload.byteLength);
    expect(read[1000]).toBe(payload[1000]);
  });

  it('deletes an object and refuses to read it afterwards', async () => {
    const driver = storage();
    const key = createStorageKey('imports', 'user1', 'obj');
    await driver.put(key, new Uint8Array([9]), 'model/obj');
    await driver.delete(key);
    await expect(driver.get(key)).rejects.toThrow();
  });

  it('tolerates deleting something that is not there', async () => {
    await expect(
      storage().delete(createStorageKey('imports', 'user1', 'stl')),
    ).resolves.toBeUndefined();
  });

  it('refuses a key that tries to escape the storage root', async () => {
    const driver = storage();
    for (const key of ['../escape', 'imports/../../etc/passwd', '/absolute']) {
      await expect(driver.put(key, new Uint8Array([1]), 'text/plain')).rejects.toThrow();
      await expect(driver.get(key)).rejects.toThrow();
    }
  });

  it('keeps two users’ objects at separate keys', async () => {
    const a = createStorageKey('imports', 'alice', 'ifc');
    const b = createStorageKey('imports', 'bob', 'ifc');
    expect(a).not.toBe(b);
    expect(a.split('/')[1]).toBe('alice');
    expect(b.split('/')[1]).toBe('bob');
  });

  it('can be replaced by an in-memory driver for tests', async () => {
    const objects = new Map<string, Uint8Array>();
    const memory: StorageDriver = {
      kind: 'local',
      async put(key, body) {
        objects.set(key, body);
        return { key, size: body.byteLength, checksum: 'test' };
      },
      async get(key) {
        const value = objects.get(key);
        if (!value) throw new Error('missing');
        return value;
      },
      async delete(key) {
        objects.delete(key);
      },
    };

    setStorageDriver(memory);
    await storage().put('imports/x/y.ifc', new Uint8Array([7]), 'text/plain');
    expect(Array.from(await storage().get('imports/x/y.ifc'))).toEqual([7]);
    setStorageDriver(null);
  });
});
