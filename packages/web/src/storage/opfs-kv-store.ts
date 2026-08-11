// Firefox private windows throw SecurityError from OPFS by design; fall back to an in-memory
// store so the vault, sync cache, biometric enrollment, and OAuth tokens still work for the
// session — just without surviving a restart, matching private browsing's own ephemeral model.

export interface KvStore {
    read(name: string): Promise<ArrayBuffer | undefined>;
    write(name: string, data: ArrayBuffer): Promise<void>;
    remove(name: string): Promise<void>;
}

class OpfsKvStore implements KvStore {
    constructor(private readonly root: FileSystemDirectoryHandle) {}

    async read(name: string): Promise<ArrayBuffer | undefined> {
        try {
            const handle = await this.root.getFileHandle(name);
            const file = await handle.getFile();
            return await file.arrayBuffer();
        } catch (e) {
            if (e instanceof DOMException && e.name === 'NotFoundError') {
                return undefined;
            }
            throw e;
        }
    }

    async write(name: string, data: ArrayBuffer): Promise<void> {
        const handle = await this.root.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write(data);
        await writable.close();
    }

    async remove(name: string): Promise<void> {
        try {
            await this.root.removeEntry(name);
        } catch (e) {
            if (!(e instanceof DOMException && e.name === 'NotFoundError')) {
                throw e;
            }
        }
    }
}

class MemoryKvStore implements KvStore {
    private readonly files = new Map<string, ArrayBuffer>();

    async read(name: string): Promise<ArrayBuffer | undefined> {
        return this.files.get(name);
    }

    async write(name: string, data: ArrayBuffer): Promise<void> {
        this.files.set(name, data);
    }

    async remove(name: string): Promise<void> {
        this.files.delete(name);
    }
}

let storePromise: Promise<KvStore> | undefined;

export function getKvStore(): Promise<KvStore> {
    storePromise ??= navigator.storage.getDirectory().then(
        (root): KvStore => new OpfsKvStore(root),
        (e): KvStore => {
            if (e instanceof DOMException && e.name === 'SecurityError') {
                return new MemoryKvStore();
            }
            throw e;
        }
    );
    return storePromise;
}
