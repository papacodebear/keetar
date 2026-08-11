import { ByteUtils } from '@keetar/core';
import { decryptAtRest, encryptAtRest } from '../storage/device-secret';
import { getKvStore } from '../storage/opfs-kv-store';

// OAuth token storage (§7.3, §4.1)—one record per provider, encrypted via device-secret.ts.
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
    const store = await getKvStore();
    await store.write(fileName(provider), ByteUtils.arrayToBuffer(ByteUtils.stringToBytes(JSON.stringify(encrypted))));
}

export async function loadTokens(provider: string): Promise<OAuthTokenRecord | undefined> {
    const store = await getKvStore();
    const data = await store.read(fileName(provider));
    if (!data) {
        return undefined;
    }
    const encrypted = JSON.parse(ByteUtils.bytesToString(data)) as { ivBase64: string; ciphertextBase64: string };
    const decrypted = await decryptAtRest(encrypted);
    return JSON.parse(ByteUtils.bytesToString(decrypted)) as OAuthTokenRecord;
}

export async function removeTokens(provider: string): Promise<void> {
    const store = await getKvStore();
    await store.remove(fileName(provider));
}
