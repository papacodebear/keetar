import type { FileProvider, FileMetadata, FileListing } from '@keetar/core';

// FileProvider over the File System Access API (§4.2, §7.2) — the near-term
// primary backend, ships first (§7.2).
//
// §4.1's UUID scheme (`SHA-256(provider + ":" + filePath)`) assumes a stable
// "filePath" string, but the File System Access API deliberately gives no
// such thing — only a sandboxed FileSystemFileHandle and its bare filename
// (`handle.name`), which isn't unique (two different files can share a
// name). So this backend mints a fresh random UUID at pick time instead and
// persists the {uuid -> handle} association directly; the UUID-namespacing
// *intent* behind §4.1 (stable, shared across backends, survives switching a
// vault between them) still holds, just via a different derivation for this
// one backend.
//
// §4.2 also documents storing the serialized handle in `chrome.storage.local`
// — that only holds JSON-serializable values, and FileSystemFileHandle isn't
// one. IndexedDB supports it via the structured clone algorithm, so that's
// what's used here instead. IndexedDB is reachable from both the service
// worker and extension pages (same origin), so this module works unmodified
// from either.

const DB_NAME = 'keetar-file-handles';
const STORE_NAME = 'handles';
const DB_VERSION = 1;

function openHandleDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function withStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
    const db = await openHandleDb();
    try {
        return await new Promise<T>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, mode);
            const request = fn(tx.objectStore(STORE_NAME));
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } finally {
        db.close();
    }
}

async function storeFileHandle(uuid: string, handle: FileSystemFileHandle): Promise<void> {
    await withStore('readwrite', (store) => store.put(handle, uuid));
}

async function getFileHandle(uuid: string): Promise<FileSystemFileHandle | undefined> {
    const handle = await withStore<FileSystemFileHandle | undefined>('readonly', (store) =>
        store.get(uuid)
    );
    return handle ?? undefined;
}

async function deleteFileHandle(uuid: string): Promise<void> {
    await withStore('readwrite', (store) => store.delete(uuid));
}

/**
 * Shows the native file picker and persists the resulting handle. Only
 * callable from a document context with active user activation (a service
 * worker has no window and cannot show this picker) — see §4.2.
 */
export async function pickVaultFile(): Promise<{ uuid: string; name: string }> {
    const [handle] = await window.showOpenFilePicker({
        types: [
            {
                description: 'KeePass database',
                accept: { 'application/octet-stream': ['.kdbx'] }
            }
        ]
    });
    const uuid = crypto.randomUUID();
    await storeFileHandle(uuid, handle);
    return { uuid, name: handle.name };
}

export class LocalFileProvider implements FileProvider {
    constructor(private readonly uuid: string) {}

    async read(_path: string): Promise<ArrayBuffer> {
        const handle = await this.getHandle();
        await this.ensurePermission(handle, 'read');
        const file = await handle.getFile();
        return file.arrayBuffer();
    }

    async write(_path: string, data: ArrayBuffer): Promise<FileMetadata> {
        const handle = await this.getHandle();
        await this.ensurePermission(handle, 'readwrite');
        const writable = await handle.createWritable();
        await writable.write(data);
        await writable.close();
        return this.metadata(_path);
    }

    async metadata(_path: string): Promise<FileMetadata> {
        const handle = await this.getHandle();
        const file = await handle.getFile();
        return {
            lastModified: new Date(file.lastModified).toISOString(),
            // No eTag concept for local files — conflict detection for this
            // backend is "re-read before every unlock" (§4.2), not §4.3's
            // cloud sync algorithm (§7.2).
            eTag: '',
            size: file.size
        };
    }

    // No in-app directory browsing for this backend: file selection goes
    // through the native OS picker (pickVaultFile), not a listing UI. §7.1
    // describes list() as being "for file picker UI", which is the cloud
    // providers' in-app folder browser (§7.3) — not applicable here.
    async list(_dir: string): Promise<FileListing[]> {
        return [];
    }

    async revoke(): Promise<void> {
        await deleteFileHandle(this.uuid);
    }

    private async getHandle(): Promise<FileSystemFileHandle> {
        const handle = await getFileHandle(this.uuid);
        if (!handle) {
            throw new Error(`no file handle stored for vault ${this.uuid}`);
        }
        return handle;
    }

    private async ensurePermission(
        handle: FileSystemFileHandle,
        mode: 'read' | 'readwrite'
    ): Promise<void> {
        const opts = { mode };
        if ((await handle.queryPermission(opts)) === 'granted') {
            return;
        }
        // Within a session, this typically resolves without a fresh prompt
        // if permission was already granted during the initial pick — the
        // browser only requires a new user gesture when it actually needs to
        // show a prompt, e.g. after permission lapses on browser restart
        // (§4.2). Crash-recovery validation (§4.2 also) is the caller's
        // responsibility, not this provider's.
        const result = await handle.requestPermission(opts);
        if (result !== 'granted') {
            throw new Error('file permission was not granted');
        }
    }
}
