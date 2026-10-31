import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test, vi } from 'vitest';

type Listener = (message: unknown) => void;
type Reply = (message: Record<string, unknown>) => Record<string, unknown>;

const host = {
    reply: (() => ({})) as Reply,
    sent: [] as Record<string, unknown>[],
    onMessage: undefined as Listener | undefined,
    onDisconnect: undefined as Listener | undefined,
    connects: 0,
    permitted: true,
    silent: false
};

vi.mock('../../src/platform', () => ({
    nativeMessaging: {
        connect: () => {
            host.connects += 1;
            return {
                onMessage: { addListener: (listener: Listener) => (host.onMessage = listener) },
                onDisconnect: { addListener: (listener: Listener) => (host.onDisconnect = listener) },
                postMessage: (message: Record<string, unknown>) => {
                    host.sent.push(message);
                    if (!host.silent) {
                        queueMicrotask(() => host.onMessage?.({ id: message.id, ok: true, ...host.reply(message) }));
                    }
                }
            };
        },
        requestPermission: async () => true,
        hasPermission: async () => host.permitted
    }
}));

const {
    HOST_VERSION,
    NativeFileProvider,
    NativeHostConflictError,
    checkNativeHostStatus,
    createNativeVaultFile,
    hostDownloadFor,
    pickNativeVaultFile
} = await import('../../src/providers/native-file');

const base64 = (text: string) => Buffer.from(text).toString('base64');

describe('NativeFileProvider', () => {
    beforeEach(() => {
        host.sent = [];
        host.reply = () => ({});
    });

    test('reassembles a vault sent in several chunks', async () => {
        const chunks = ['hello ', 'large ', 'vault'];
        host.reply = (message) => {
            const index = host.sent.filter((sent) => sent.op === 'read').length - 1;
            expect(message.offset).toBe(chunks.slice(0, index).join('').length);
            return { dataBase64: base64(chunks[index]), size: 17, etag: 'e1', done: index === chunks.length - 1 };
        };
        const data = await new NativeFileProvider().read('/v.kdbx');
        expect(new TextDecoder().decode(data)).toBe('hello large vault');
    });

    test('saves against the version it read, then the version it wrote', async () => {
        const provider = new NativeFileProvider();
        host.reply = () => ({ dataBase64: '', size: 0, etag: 'read-etag', done: true });
        await provider.read('/v.kdbx');
        host.reply = () => ({ size: 1, modifiedMs: 1000, etag: 'write-1' });
        await provider.write('/v.kdbx', new Uint8Array([1]).buffer);
        await provider.write('/v.kdbx', new Uint8Array([2]).buffer);
        const writes = host.sent.filter((sent) => sent.op === 'write');
        expect(writes.map((sent) => sent.expected_etag)).toEqual(['read-etag', 'write-1']);
    });

    test('surfaces an outside change as a conflict', async () => {
        const provider = new NativeFileProvider();
        const pendingWrite = provider.write('/v.kdbx', new ArrayBuffer(1));
        host.onMessage?.({ id: host.sent.at(-1)?.id, ok: false, code: 'CONFLICT', error: 'changed' });
        await expect(pendingWrite).rejects.toBeInstanceOf(NativeHostConflictError);
    });

    test('maps stat results to file metadata', async () => {
        host.reply = () => ({ size: 5, modifiedMs: 0, etag: 'abc' });
        await expect(new NativeFileProvider().metadata('/v.kdbx')).resolves.toEqual({
            lastModified: '1970-01-01T00:00:00.000Z',
            eTag: 'abc',
            size: 5
        });
    });
});

describe('picking files', () => {
    beforeEach(() => {
        host.sent = [];
    });

    test('treats a cancelled dialog as no choice', async () => {
        host.reply = () => ({ path: null });
        await expect(pickNativeVaultFile()).resolves.toBeUndefined();
    });

    test('creating a vault adds the extension and writes the chosen file', async () => {
        host.reply = (message) => (message.op === 'pick_save' ? { path: '/d/My.kdbx', name: 'My.kdbx' } : { size: 1, modifiedMs: 0, etag: 'e' });
        await expect(createNativeVaultFile('My', new ArrayBuffer(1))).resolves.toEqual({ path: '/d/My.kdbx', name: 'My.kdbx' });
        expect(host.sent[0]).toMatchObject({ op: 'pick_save', suggested_name: 'My.kdbx' });
        expect(host.sent[1]).toMatchObject({ op: 'write', path: '/d/My.kdbx' });
        expect(host.sent[1].expected_etag).toBeUndefined();
    });

    test('cancelling the save dialog writes nothing', async () => {
        host.reply = () => ({ path: null });
        await expect(createNativeVaultFile('My', new ArrayBuffer(1))).resolves.toBeUndefined();
        expect(host.sent).toHaveLength(1);
    });
});

describe('when the helper is missing or stops', () => {
    test('explains how to install it and reconnects next time', async () => {
        const connectsBefore = host.connects;
        host.reply = () => ({ size: 1, modifiedMs: 0, etag: 'e' });
        await new NativeFileProvider().metadata('/v.kdbx');
        const provider = new NativeFileProvider();
        host.silent = true;
        const failed = provider.metadata('/v.kdbx');
        host.onDisconnect?.({ error: { message: 'No such native application com.keetar.host' } });
        await expect(failed).rejects.toThrow(/helper app/);
        host.silent = false;
        await provider.metadata('/v.kdbx');
        expect(host.connects).toBeGreaterThan(connectsBefore);
    });
});

describe('helper status', () => {
    beforeEach(() => {
        host.permitted = true;
        host.silent = false;
        host.reply = () => ({});
    });

    test('reports the version when the helper answers', async () => {
        host.reply = () => ({ version: '0.1.0' });
        await expect(checkNativeHostStatus()).resolves.toEqual({ kind: 'connected', version: '0.1.0' });
    });

    test('does not try to connect without permission', async () => {
        host.permitted = false;
        const sentBefore = host.sent.length;
        await expect(checkNativeHostStatus()).resolves.toEqual({ kind: 'needs-permission' });
        expect(host.sent).toHaveLength(sentBefore);
    });

    test('recognises a helper that is not installed', async () => {
        host.silent = true;
        const status = checkNativeHostStatus();
        await Promise.resolve();
        await Promise.resolve();
        host.onDisconnect?.({ error: { message: 'No such native application com.keetar.host' } });
        await expect(status).resolves.toEqual({ kind: 'missing' });
    });

    test('treats other disconnects as errors', async () => {
        host.silent = true;
        const status = checkNativeHostStatus();
        await Promise.resolve();
        await Promise.resolve();
        host.onDisconnect?.({ error: { message: 'boom' } });
        await expect(status).resolves.toMatchObject({ kind: 'error' });
    });
});

describe('helper downloads', () => {
    test.each([
        ['Linux x86_64', 'keetar-host-linux-x86_64'],
        ['MacIntel', 'keetar-host-macos-aarch64'],
        ['Win32', 'keetar-host-windows-x86_64.exe']
    ])('%s gets %s from the pinned release', (platform, asset) => {
        expect(hostDownloadFor(platform)?.url).toBe(
            `https://github.com/papacodebear/keetar/releases/download/host-v${HOST_VERSION}/${asset}`
        );
    });

    test('offers nothing for unknown platforms', () => {
        expect(hostDownloadFor('Solaris')).toBeUndefined();
    });

    test('the pinned version matches the helper crate', () => {
        const cargoToml = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../host/Cargo.toml');
        expect(readFileSync(cargoToml, 'utf8')).toContain(`version = "${HOST_VERSION}"`);
    });

    test('every download exists in the release workflow', () => {
        const workflow = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.github/workflows/host-release.yml');
        const assets = readFileSync(workflow, 'utf8');
        for (const platform of ['Linux', 'MacIntel', 'Win32']) {
            expect(assets).toContain(hostDownloadFor(platform)?.url.split('/').pop());
        }
    });
});
