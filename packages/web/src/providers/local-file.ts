import type { FileProvider, FileMetadata, FileListing } from '@keetar/core';

// File System Access API: mints random UUID at pick time (no stable filePath)—persists via IndexedDB for service worker + pages.

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

/** Shows the native file picker and persists the resulting handle — must be called from a document context, not a service worker. */
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

/** Same document-context constraint as pickVaultFile(), but for saving a brand-new vault file. */
export async function createVaultFile(name: string, data: ArrayBuffer): Promise<{ uuid: string; name: string }> {
    const handle = await window.showSaveFilePicker({
        suggestedName: name.toLowerCase().endsWith('.kdbx') ? name : `${name}.kdbx`,
        types: [
            {
                description: 'KeePass database',
                accept: { 'application/octet-stream': ['.kdbx'] }
            }
        ]
    });
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
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
            // No eTag—conflict detection is re-read-before-unlock (§4.2), not cloud sync (§4.3).
            eTag: '',
            size: file.size
        };
    }

    // No in-app directory browser—user picks via native OS picker, not in-app UI.
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
        // Within session, typically no fresh prompt if already granted; browser requires new gesture only after permission lapses.
        const result = await handle.requestPermission(opts);
        if (result !== 'granted') {
            throw new Error('file permission was not granted');
        }
    }
}
