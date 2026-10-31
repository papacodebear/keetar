import { ByteUtils, type FileListing, type FileMetadata, type FileProvider } from '@keetar/core';
import { nativeMessaging } from '../platform';

// Firefox has no File System Access API, so local vaults go through the keetar-host helper (packages/host).
const HOST_NAME = 'com.keetar.host';
const PING_TIMEOUT_MS = 5000;
// Pinned so each extension release downloads the helper it was built against; must match packages/host/Cargo.toml.
export const HOST_VERSION = '0.1.0';
export const HOST_INSTALL_URL = 'https://github.com/papacodebear/keetar/tree/main/packages/host';
const HOST_DOWNLOAD_BASE = `https://github.com/papacodebear/keetar/releases/download/host-v${HOST_VERSION}`;

type HostReply = { id: number; ok: true; [key: string]: unknown } | { id: number; ok: false; code: string; error: string };

interface PendingRequest {
    resolve: (reply: Record<string, unknown>) => void;
    reject: (error: Error) => void;
}

export class NativeHostConflictError extends Error {
    constructor() {
        super('This database changed on disk since Keetar opened it. Your latest edit was not saved. Lock and reopen the database to load the other change.');
        this.name = 'NativeHostConflictError';
    }
}

export class NativeHostMissingError extends Error {
    constructor() {
        super(`Local databases in Firefox need the Keetar helper app. Install it from ${HOST_INSTALL_URL}, then try again.`);
        this.name = 'NativeHostMissingError';
    }
}

let port: chrome.runtime.Port | undefined;
let nextRequestId = 1;
const pending = new Map<number, PendingRequest>();

function connect(): chrome.runtime.Port {
    if (port) {
        return port;
    }
    const connected = nativeMessaging.connect(HOST_NAME);
    connected.onMessage.addListener((message: HostReply) => {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (!request) {
            return;
        }
        if (message.ok) {
            request.resolve(message);
        } else if (message.code === 'CONFLICT') {
            request.reject(new NativeHostConflictError());
        } else {
            request.reject(new Error(message.error));
        }
    });
    connected.onDisconnect.addListener((closed) => {
        port = undefined;
        const reason = (closed as chrome.runtime.Port & { error?: Error }).error?.message;
        for (const request of pending.values()) {
            request.reject(disconnectError(reason));
        }
        pending.clear();
    });
    port = connected;
    return connected;
}

function disconnectError(reason: string | undefined): Error {
    if (reason?.includes('No such native application')) {
        return new NativeHostMissingError();
    }
    return new Error(`The Keetar helper app stopped unexpectedly${reason ? `: ${reason}` : '.'}`);
}

function request<T>(message: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const id = nextRequestId++;
        const connected = connect();
        pending.set(id, { resolve: resolve as PendingRequest['resolve'], reject });
        connected.postMessage({ ...message, id });
    });
}

export interface HostDownload {
    label: string;
    url: string;
    instructions: string;
}

// Browsers can't run downloads, so the last step always has to be the user's.
export function hostDownloadFor(platform: string): HostDownload | undefined {
    if (/linux/i.test(platform)) {
        return {
            label: 'Linux',
            url: `${HOST_DOWNLOAD_BASE}/keetar-host-linux-x86_64`,
            instructions: 'Move it somewhere permanent, then run: chmod +x keetar-host-linux-x86_64 && ./keetar-host-linux-x86_64'
        };
    }
    if (/mac/i.test(platform)) {
        return {
            label: 'macOS',
            url: `${HOST_DOWNLOAD_BASE}/keetar-host-macos-aarch64`,
            instructions:
                'Move it somewhere permanent. The helper is not yet signed, so run this in Terminal: xattr -d com.apple.quarantine keetar-host-macos-aarch64 && chmod +x keetar-host-macos-aarch64 && ./keetar-host-macos-aarch64'
        };
    }
    if (/win/i.test(platform)) {
        return {
            label: 'Windows',
            url: `${HOST_DOWNLOAD_BASE}/keetar-host-windows-x86_64.exe`,
            instructions: 'Move it somewhere permanent, then run it. The helper is not yet signed, so choose More info, then Run anyway.'
        };
    }
    return undefined;
}

export type NativeHostStatus =
    | { kind: 'needs-permission' }
    | { kind: 'missing' }
    | { kind: 'connected'; version: string }
    | { kind: 'error'; message: string };

// The helper starts on demand, so a successful ping is what "installed and working" means.
export async function checkNativeHostStatus(): Promise<NativeHostStatus> {
    if (!(await nativeMessaging.hasPermission())) {
        return { kind: 'needs-permission' };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The Keetar helper app did not respond.')), PING_TIMEOUT_MS);
    });
    try {
        const { version } = await Promise.race([request<{ version: string }>({ op: 'ping' }), timeout]);
        return { kind: 'connected', version };
    } catch (e) {
        if (e instanceof NativeHostMissingError) {
            return { kind: 'missing' };
        }
        return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
    } finally {
        clearTimeout(timer);
    }
}

interface PickedFile {
    path: string | null;
    name?: string;
}

/** Must be the first thing a click handler does, since Firefox only allows this prompt during a user gesture. */
export async function ensureNativeHostPermission(): Promise<void> {
    if (!(await nativeMessaging.requestPermission())) {
        throw new Error('Keetar needs permission to talk to its helper app to open local databases.');
    }
}

export async function pickNativeVaultFile(): Promise<{ path: string; name: string } | undefined> {
    const { path, name } = await request<PickedFile>({ op: 'pick_open' });
    return path ? { path, name: name ?? path } : undefined;
}

export async function createNativeVaultFile(name: string, data: ArrayBuffer): Promise<{ path: string; name: string } | undefined> {
    const suggested_name = name.toLowerCase().endsWith('.kdbx') ? name : `${name}.kdbx`;
    const picked = await request<PickedFile>({ op: 'pick_save', suggested_name });
    if (!picked.path) {
        return undefined;
    }
    await request({ op: 'write', path: picked.path, data_base64: ByteUtils.bytesToBase64(new Uint8Array(data)) });
    return { path: picked.path, name: picked.name ?? picked.path };
}

interface ReadChunk {
    dataBase64: string;
    size: number;
    etag: string;
    done: boolean;
}

interface FileStat {
    size: number;
    modifiedMs: number;
    etag: string;
}

export class NativeFileProvider implements FileProvider {
    // Host refuses a save if the file no longer matches this, so edits from KeePassXC are never clobbered.
    private lastKnownEtag: string | undefined;

    async read(path: string): Promise<ArrayBuffer> {
        const chunks: Uint8Array[] = [];
        let offset = 0;
        for (;;) {
            const chunk = await request<ReadChunk>({ op: 'read', path, offset });
            const bytes = ByteUtils.base64ToBytes(chunk.dataBase64);
            chunks.push(bytes);
            offset += bytes.length;
            if (chunk.done) {
                this.lastKnownEtag = chunk.etag;
                return joinChunks(chunks, offset);
            }
        }
    }

    async write(path: string, data: ArrayBuffer): Promise<FileMetadata> {
        const written = await request<FileStat>({
            op: 'write',
            path,
            data_base64: ByteUtils.bytesToBase64(new Uint8Array(data)),
            expected_etag: this.lastKnownEtag
        });
        this.lastKnownEtag = written.etag;
        return toFileMetadata(written);
    }

    async metadata(path: string): Promise<FileMetadata> {
        return toFileMetadata(await request<FileStat>({ op: 'stat', path }));
    }

    // Files are chosen in the OS dialog, so there's no in-app directory browser.
    async list(_dir: string): Promise<FileListing[]> {
        return [];
    }

    async revoke(): Promise<void> {}
}

function joinChunks(chunks: Uint8Array[], size: number): ArrayBuffer {
    const joined = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) {
        joined.set(chunk, position);
        position += chunk.length;
    }
    return joined.buffer;
}

function toFileMetadata(stat: FileStat): FileMetadata {
    return { lastModified: new Date(stat.modifiedMs).toISOString(), eTag: stat.etag, size: stat.size };
}
