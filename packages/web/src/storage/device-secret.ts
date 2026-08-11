import { ByteUtils } from '@keetar/core';

// Device-local AES-GCM key in OPFS for encrypting OAuth tokens and other secrets.
const FILE_NAME = 'device-secret.bin';
const KEY_LENGTH_BYTES = 32;

let cachedKey: Promise<CryptoKey> | undefined;

function getOrCreateDeviceSecret(): Promise<CryptoKey> {
    cachedKey ??= loadOrGenerate();
    return cachedKey;
}

async function loadOrGenerate(): Promise<CryptoKey> {
    const root = await navigator.storage.getDirectory();
    let raw: ArrayBuffer;
    try {
        const handle = await root.getFileHandle(FILE_NAME);
        const file = await handle.getFile();
        raw = await file.arrayBuffer();
    } catch (e) {
        if (!(e instanceof DOMException && e.name === 'NotFoundError')) {
            throw e;
        }
        raw = ByteUtils.arrayToBuffer(globalThis.crypto.getRandomValues(new Uint8Array(KEY_LENGTH_BYTES)));
        const handle = await root.getFileHandle(FILE_NAME, { create: true });
        const writable = await handle.createWritable();
        await writable.write(raw);
        await writable.close();
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
