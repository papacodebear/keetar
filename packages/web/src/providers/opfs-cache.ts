import { ByteUtils } from '@keetar/core';
import type { FileListing, FileMetadata, FileProvider } from '@keetar/core';
import { CloudConflictError } from './gdrive';
import { getKvStore } from '../storage/opfs-kv-store';

// §4.3's sync algorithm with a local cache + metadata; enables offline access and cross-session conflict detection.

export interface CacheMeta {
    provider: string;
    filePath: string;
    lastModified: string;
    eTag: string;
    /** True when the cached blob has local edits not yet confirmed written to the cloud copy. */
    dirty: boolean;
}

function blobFileName(uuid: string): string {
    return `vault-${uuid}.kdbx`;
}

function metaFileName(uuid: string): string {
    return `vault-${uuid}.meta.json`;
}

async function readCacheBlob(uuid: string): Promise<ArrayBuffer | undefined> {
    const store = await getKvStore();
    return store.read(blobFileName(uuid));
}

async function writeCacheBlob(uuid: string, data: ArrayBuffer): Promise<void> {
    const store = await getKvStore();
    await store.write(blobFileName(uuid), data);
}

export async function readCacheMeta(uuid: string): Promise<CacheMeta | undefined> {
    const store = await getKvStore();
    const data = await store.read(metaFileName(uuid));
    return data ? (JSON.parse(ByteUtils.bytesToString(data)) as CacheMeta) : undefined;
}

async function writeCacheMeta(uuid: string, meta: CacheMeta): Promise<void> {
    const store = await getKvStore();
    await store.write(metaFileName(uuid), ByteUtils.arrayToBuffer(ByteUtils.stringToBytes(JSON.stringify(meta))));
}

export async function removeCache(uuid: string): Promise<void> {
    const store = await getKvStore();
    await store.remove(blobFileName(uuid));
    await store.remove(metaFileName(uuid));
}

/** Thrown when both the cloud copy and this device's cache changed since they last agreed — §4.3 step 3c: never silently overwrite either. */
export class SyncConflictError extends Error {
    constructor() {
        super('This vault changed both here (while offline) and in the cloud. Resolve which copy to keep in Options before unlocking.');
        this.name = 'SyncConflictError';
    }
}

export type SyncStatus = 'ok' | 'cloud-newer' | 'conflict';

export class OpfsCachedProvider implements FileProvider {
    constructor(
        private readonly uuid: string,
        private readonly cloud: FileProvider
    ) {}

    // Fetch cloud metadata on unlock, compare with cache, re-fetch blob only if cloud changed (unchanged serves from OPFS, works offline).
    async read(path: string): Promise<ArrayBuffer> {
        const cachedMeta = await readCacheMeta(this.uuid);

        let cloudMeta: FileMetadata | undefined;
        let cloudError: unknown;
        try {
            cloudMeta = await this.cloud.metadata(path);
        } catch (e) {
            cloudError = e;
        }

        if (!cloudMeta) {
            // Offline/failure: serve cache; no cache yet means real failure (token, file id, etc).
            const cached = await readCacheBlob(this.uuid);
            if (!cached) {
                throw cloudError instanceof Error
                    ? cloudError
                    : new Error('Google Drive is unreachable and no offline copy of this vault exists yet');
            }
            return cached;
        }

        if (!cachedMeta) {
            // First time this vault's been opened on this device.
            const data = await this.cloud.read(path);
            await writeCacheBlob(this.uuid, data);
            await writeCacheMeta(this.uuid, { provider: 'gdrive', filePath: path, ...cloudMeta, dirty: false });
            return data;
        }

        const cloudChanged = cloudMeta.eTag !== cachedMeta.eTag;
        if (cachedMeta.dirty && cloudChanged) {
            throw new SyncConflictError();
        }
        if (cloudChanged) {
            const data = await this.cloud.read(path);
            await writeCacheBlob(this.uuid, data);
            await writeCacheMeta(this.uuid, { provider: 'gdrive', filePath: path, ...cloudMeta, dirty: false });
            return data;
        }

        // Cloud unchanged: serve cache (even if offline-dirty); if blob missing, fetch from cloud.
        const cached = await readCacheBlob(this.uuid);
        if (cached) {
            return cached;
        }
        const data = await this.cloud.read(path);
        await writeCacheBlob(this.uuid, data);
        return data;
    }

    // Cloud first; genuine conflict propagates immediately; network failure falls back to 'keep working locally, sync later'.
    async write(path: string, data: ArrayBuffer): Promise<FileMetadata> {
        try {
            const meta = await this.cloud.write(path, data);
            await writeCacheBlob(this.uuid, data);
            await writeCacheMeta(this.uuid, { provider: 'gdrive', filePath: path, ...meta, dirty: false });
            return meta;
        } catch (e) {
            if (e instanceof CloudConflictError) {
                throw e;
            }
            await writeCacheBlob(this.uuid, data);
            const cachedMeta = await readCacheMeta(this.uuid);
            await writeCacheMeta(this.uuid, {
                provider: 'gdrive',
                filePath: path,
                lastModified: new Date().toISOString(),
                eTag: cachedMeta?.eTag ?? '',
                dirty: true
            });
            // Edit safe in OPFS, not yet confirmed in cloud; caller gets local metadata, not error (§14's auto-save never blocks).
            return { lastModified: new Date().toISOString(), eTag: cachedMeta?.eTag ?? '', size: data.byteLength };
        }
    }

    async metadata(path: string): Promise<FileMetadata> {
        try {
            return await this.cloud.metadata(path);
        } catch (e) {
            const cachedMeta = await readCacheMeta(this.uuid);
            if (!cachedMeta) {
                throw e instanceof Error
                    ? e
                    : new Error('Google Drive is unreachable and no offline copy of this vault exists yet');
            }
            const cached = await readCacheBlob(this.uuid);
            return { lastModified: cachedMeta.lastModified, eTag: cachedMeta.eTag, size: cached?.byteLength ?? 0 };
        }
    }

    async list(dir: string): Promise<FileListing[]> {
        return this.cloud.list(dir);
    }

    async revoke(): Promise<void> {
        await this.cloud.revoke();
        await removeCache(this.uuid);
    }

    // Options-triggered checks/fixes, not normal read/write in unlock/save path.

    // Metadata-only check (lets Options show conflict state without unlocking).
    async checkSyncStatus(path: string): Promise<SyncStatus> {
        const cachedMeta = await readCacheMeta(this.uuid);
        if (!cachedMeta) {
            return 'ok';
        }
        const cloudMeta = await this.cloud.metadata(path);
        const cloudChanged = cloudMeta.eTag !== cachedMeta.eTag;
        if (cachedMeta.dirty && cloudChanged) {
            return 'conflict';
        }
        return cloudChanged ? 'cloud-newer' : 'ok';
    }

    // 'keep-cloud': discard cache, re-fetch; 'keep-local': force-push cache, bypassing gdrive.ts's revision guard.
    async resolveConflict(path: string, resolution: 'keep-local' | 'keep-cloud'): Promise<void> {
        if (resolution === 'keep-cloud') {
            const data = await this.cloud.read(path);
            const meta = await this.cloud.metadata(path);
            await writeCacheBlob(this.uuid, data);
            await writeCacheMeta(this.uuid, { provider: 'gdrive', filePath: path, ...meta, dirty: false });
            return;
        }
        const cached = await readCacheBlob(this.uuid);
        if (!cached) {
            throw new Error('no local copy to keep');
        }
        // Bypasses cloud's revision guard—user explicitly chose to overwrite the conflict.
        const meta = isForceWritable(this.cloud)
            ? await this.cloud.forceWrite(path, cached)
            : await this.cloud.write(path, cached);
        await writeCacheMeta(this.uuid, { provider: 'gdrive', filePath: path, ...meta, dirty: false });
    }
}

// Providers with bypassable in-session conflict guard (local-file.ts has no guard to bypass).
interface ForceWritable {
    forceWrite(path: string, data: ArrayBuffer): Promise<FileMetadata>;
}

function isForceWritable(provider: FileProvider): provider is FileProvider & ForceWritable {
    return typeof (provider as Partial<ForceWritable>).forceWrite === 'function';
}
