import { ByteUtils } from '@keetar/core';
import { decryptAtRest, encryptAtRest } from '../storage/device-secret';

// OAuth token storage (§7.3, §4.1)—one record per provider, encrypted via device-secret.ts, in OPFS.
export interface OAuthTokenRecord {
    accessToken: string;
    refreshToken: string | undefined;
    /** Epoch milliseconds. */
    expiresAt: number;
}

function fileName(provider: string): string {
    return `oauth-${provider}.json`;
}

export async function saveTokens(provider: string, record: OAuthTokenRecord): Promise<void> {
    const encrypted = await encryptAtRest(ByteUtils.arrayToBuffer(ByteUtils.stringToBytes(JSON.stringify(record))));
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(fileName(provider), { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(encrypted));
    await writable.close();
}

export async function loadTokens(provider: string): Promise<OAuthTokenRecord | undefined> {
    const root = await navigator.storage.getDirectory();
    try {
        const handle = await root.getFileHandle(fileName(provider));
        const file = await handle.getFile();
        const encrypted = JSON.parse(await file.text()) as { ivBase64: string; ciphertextBase64: string };
        const decrypted = await decryptAtRest(encrypted);
        return JSON.parse(ByteUtils.bytesToString(decrypted)) as OAuthTokenRecord;
    } catch (e) {
        if (e instanceof DOMException && e.name === 'NotFoundError') {
            return undefined;
        }
        throw e;
    }
}

export async function removeTokens(provider: string): Promise<void> {
    const root = await navigator.storage.getDirectory();
    try {
        await root.removeEntry(fileName(provider));
    } catch (e) {
        if (!(e instanceof DOMException && e.name === 'NotFoundError')) {
            throw e;
        }
    }
}
