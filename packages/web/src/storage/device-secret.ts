import { ByteUtils } from '@keetar/core';
import { getKvStore } from './opfs-kv-store';

// Device-local AES-GCM key for encrypting OAuth tokens and other secrets.
const FILE_NAME = 'device-secret.bin';
const KEY_LENGTH_BYTES = 32;

let cachedKey: Promise<CryptoKey> | undefined;

function getOrCreateDeviceSecret(): Promise<CryptoKey> {
    cachedKey ??= loadOrGenerate();
    return cachedKey;
}

async function loadOrGenerate(): Promise<CryptoKey> {
    const store = await getKvStore();
    let raw = await store.read(FILE_NAME);
    if (!raw) {
        raw = ByteUtils.arrayToBuffer(globalThis.crypto.getRandomValues(new Uint8Array(KEY_LENGTH_BYTES)));
        await store.write(FILE_NAME, raw);
    }
    return globalThis.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export interface EncryptedAtRest {
    ivBase64: string;
    ciphertextBase64: string;
}

export async function encryptAtRest(data: ArrayBuffer): Promise<EncryptedAtRest> {
    const key = await getOrCreateDeviceSecret();
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return {
        ivBase64: ByteUtils.bytesToBase64(iv),
        ciphertextBase64: ByteUtils.bytesToBase64(new Uint8Array(ciphertext))
    };
}

export async function decryptAtRest(encrypted: EncryptedAtRest): Promise<ArrayBuffer> {
    const key = await getOrCreateDeviceSecret();
    const iv = ByteUtils.base64ToBytes(encrypted.ivBase64);
    const ciphertext = ByteUtils.base64ToBytes(encrypted.ciphertextBase64);
    return globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
}
