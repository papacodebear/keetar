import { ByteUtils } from '@keetar/core';
import { getKvStore } from '../storage/opfs-kv-store';

// Biometric record per vault: credentialId, prfSalt, wrapped hash always together (§4.1, §6.2).

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
    const store = await getKvStore();
    await store.write(fileName(vaultUuid), ByteUtils.arrayToBuffer(ByteUtils.stringToBytes(JSON.stringify(record))));
}

export async function getBiometricRecord(vaultUuid: string): Promise<BiometricRecord | undefined> {
    const store = await getKvStore();
    const data = await store.read(fileName(vaultUuid));
    return data ? (JSON.parse(ByteUtils.bytesToString(data)) as BiometricRecord) : undefined;
}

export async function removeBiometricRecord(vaultUuid: string): Promise<void> {
    const store = await getKvStore();
    await store.remove(fileName(vaultUuid));
}

export function bufferToBase64(buffer: ArrayBuffer): string {
    return ByteUtils.bytesToBase64(new Uint8Array(buffer));
}

export function base64ToBuffer(value: string): ArrayBuffer {
    return ByteUtils.arrayToBuffer(ByteUtils.base64ToBytes(value));
}
