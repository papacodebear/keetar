import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// getKvStore() caches its result at module scope, so each test needs a fresh module instance.
async function freshGetKvStore() {
    vi.resetModules();
    const module = await import('../../src/storage/opfs-kv-store');
    return module.getKvStore;
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('getKvStore', () => {
    test('falls back to an in-memory store when OPFS throws SecurityError (Firefox private windows)', async () => {
        vi.stubGlobal('navigator', {
            storage: { getDirectory: vi.fn().mockRejectedValue(new DOMException('blocked', 'SecurityError')) }
        });
        const getKvStore = await freshGetKvStore();
        const store = await getKvStore();

        expect(await store.read('missing')).toBeUndefined();
        const data = new TextEncoder().encode('hello').buffer;
        await store.write('file.txt', data);
        expect(new Uint8Array((await store.read('file.txt'))!)).toEqual(new Uint8Array(data));
        await store.remove('file.txt');
        expect(await store.read('file.txt')).toBeUndefined();
    });

    test('rethrows errors that are not the known SecurityError case', async () => {
        vi.stubGlobal('navigator', {
            storage: { getDirectory: vi.fn().mockRejectedValue(new Error('disk full')) }
        });
        const getKvStore = await freshGetKvStore();
        await expect(getKvStore()).rejects.toThrow('disk full');
    });

    test('uses the real OPFS root and maps its NotFoundError to undefined when it is available', async () => {
        const files = new Map<string, ArrayBuffer>();
        const fakeRoot = {
            getFileHandle: vi.fn(async (name: string, options?: { create?: boolean }) => {
                if (!files.has(name) && !options?.create) {
                    throw new DOMException('no such file', 'NotFoundError');
                }
                return {
                    getFile: async () => ({ arrayBuffer: async () => files.get(name) }),
                    createWritable: async () => ({
                        write: async (data: ArrayBuffer) => {
                            files.set(name, data);
                        },
                        close: async () => undefined
                    })
                };
            }),
            removeEntry: vi.fn(async (name: string) => {
                if (!files.has(name)) {
                    throw new DOMException('no such file', 'NotFoundError');
                }
                files.delete(name);
            })
        };
        vi.stubGlobal('navigator', { storage: { getDirectory: vi.fn().mockResolvedValue(fakeRoot) } });
        const getKvStore = await freshGetKvStore();
        const store = await getKvStore();

        expect(await store.read('missing')).toBeUndefined();
        const data = new TextEncoder().encode('hello').buffer;
        await store.write('file.txt', data);
        expect(new Uint8Array((await store.read('file.txt'))!)).toEqual(new Uint8Array(data));
        await store.remove('file.txt');
        expect(await store.read('file.txt')).toBeUndefined();
        // Removing an already-absent file is a no-op, not an error.
        await expect(store.remove('file.txt')).resolves.toBeUndefined();
    });
});
