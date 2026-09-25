import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { FileMetadata, FileProvider } from '@keetar/core';

const files = new Map<string, ArrayBuffer>();

vi.mock('../../src/storage/opfs-kv-store', () => ({
    getKvStore: async () => ({
        read: async (name: string) => files.get(name),
        write: async (name: string, data: ArrayBuffer) => {
            files.set(name, data);
        },
        remove: async (name: string) => {
            files.delete(name);
        }
    })
}));

import { CloudConflictError, DriveAuthError } from '../../src/providers/gdrive';
import { OpfsCachedProvider } from '../../src/providers/opfs-cache';

function fakeCloud(overrides: Partial<FileProvider> = {}): FileProvider {
    return {
        read: vi.fn(),
        write: vi.fn(),
        metadata: vi.fn(),
        list: vi.fn(),
        revoke: vi.fn(),
        ...overrides
    } as unknown as FileProvider;
}

beforeEach(() => {
    files.clear();
});

describe('OpfsCachedProvider.write', () => {
    test('a stale-auth failure propagates instead of being swallowed into a silent dirty cache', async () => {
        const cloud = fakeCloud({ write: vi.fn().mockRejectedValue(new DriveAuthError()) });
        const provider = new OpfsCachedProvider('vault-1', cloud);

        await expect(provider.write('file-id', new ArrayBuffer(4))).rejects.toBeInstanceOf(DriveAuthError);
    });

    test('a conflict still propagates (regression guard)', async () => {
        const cloud = fakeCloud({ write: vi.fn().mockRejectedValue(new CloudConflictError()) });
        const provider = new OpfsCachedProvider('vault-1', cloud);

        await expect(provider.write('file-id', new ArrayBuffer(4))).rejects.toBeInstanceOf(CloudConflictError);
    });

    test('an ordinary network failure still falls back to a local dirty cache (offline editing)', async () => {
        const cloud = fakeCloud({ write: vi.fn().mockRejectedValue(new Error('network down')) });
        const provider = new OpfsCachedProvider('vault-1', cloud);

        await expect(provider.write('file-id', new ArrayBuffer(4))).resolves.toBeDefined();
    });
});

describe('OpfsCachedProvider.checkSyncStatus', () => {
    test('reports "unsynced", not "ok", when local edits never reached an unchanged cloud copy', async () => {
        const meta = { lastModified: 'now', eTag: 'etag-1', size: 4 } satisfies FileMetadata;
        const write = vi.fn().mockResolvedValueOnce(meta).mockRejectedValueOnce(new Error('network down'));
        const cloud = fakeCloud({ write, metadata: vi.fn().mockResolvedValue(meta) });
        const provider = new OpfsCachedProvider('vault-1', cloud);
        await provider.write('file-id', new ArrayBuffer(4)); // establishes a clean baseline at eTag 'etag-1'
        await provider.write('file-id', new ArrayBuffer(4)); // fails; falls back to dirty cache, cloud eTag unchanged

        await expect(provider.checkSyncStatus('file-id')).resolves.toBe('unsynced');
    });
});
