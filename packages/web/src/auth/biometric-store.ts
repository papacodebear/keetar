import { ByteUtils } from '@keetar/core';

// OPFS biometric record per vault: credentialId, prfSalt, wrapped hash always together (§4.1, §6.2).

export interface BiometricRecord {
    credentialIdBase64: string;
    prfSaltBase64: string;
    wrappedPasswordHashBase64: string;
    enrolledAt: string;
}

function fileName(vaultUuid: string): string {
    return `biometric-${vaultUuid}.json`;
}

export async function saveBiometricRecord(vaultUuid: string, record: BiometricRecord): Promise<void> {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(fileName(vaultUuid), { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(record));
    await writable.close();
}

export async function getBiometricRecord(vaultUuid: string): Promise<BiometricRecord | undefined> {
    const root = await navigator.storage.getDirectory();
    try {
        const handle = await root.getFileHandle(fileName(vaultUuid));
        const file = await handle.getFile();
        return JSON.parse(await file.text()) as BiometricRecord;
    } catch (e) {
        if (e instanceof DOMException && e.name === 'NotFoundError') {
            return undefined;
        }
        throw e;
    }
}

export async function removeBiometricRecord(vaultUuid: string): Promise<void> {
    const root = await navigator.storage.getDirectory();
    try {
        await root.removeEntry(fileName(vaultUuid));
    } catch (e) {
        if (!(e instanceof DOMException && e.name === 'NotFoundError')) {
            throw e;
        }
    }
}

export function bufferToBase64(buffer: ArrayBuffer): string {
    return ByteUtils.bytesToBase64(new Uint8Array(buffer));
}

export function base64ToBuffer(value: string): ArrayBuffer {
    return ByteUtils.arrayToBuffer(ByteUtils.base64ToBytes(value));
}
