import { ByteUtils, Kdbx, KdbxCredentials, ProtectedValue, SessionKey } from '@keetar/core';
import { enrollCredential, getAssertionVuk } from './webauthn';
import {
    base64ToBuffer,
    bufferToBase64,
    getBiometricRecord,
    removeBiometricRecord,
    saveBiometricRecord,
    type BiometricUserVerification
} from './biometric-store';
import { ensureVaultFilePermission } from '../providers/local-file';
import { createFileProvider } from '../providers';
import { readCacheBlob } from '../providers/opfs-cache';
import type { ConfiguredVault } from '../config/vault-config';

// Enroll + unlock orchestration; enrollment is scoped, ephemeral (§6.2, §8.1).

export async function isBiometricEnrolled(vaultUuid: string): Promise<boolean> {
    return (await getBiometricRecord(vaultUuid)) !== undefined;
}

// Kicked off when the Options page's biometric section mounts, well before any click — so even a
// vault with no local cache yet has its Drive round trip done long before enroll() needs the bytes.
const prefetchedReads = new Map<string, Promise<ArrayBuffer>>();

export function prefetchForBiometricEnroll(vault: ConfiguredVault): void {
    if (vault.provider === 'gdrive' && !prefetchedReads.has(vault.uuid)) {
        prefetchedReads.set(vault.uuid, createFileProvider(vault).read(vault.path ?? ''));
    }
}

export async function enroll(
    vault: ConfiguredVault,
    password: string,
    userVerification: BiometricUserVerification
): Promise<void> {
    // Verify password before enrolling; typo fails now, not at first unlock (§6.2).
    // File System Access permission is a local-file-only concept; Drive uses its own stored OAuth token.
    if (vault.provider === 'local-file') {
        await ensureVaultFilePermission(vault.uuid);
    }
    const data = await readForVerification(vault);
    const credentials = new KdbxCredentials(ProtectedValue.fromString(password));
    await Kdbx.load(data, credentials); // throws if the password is wrong; result itself is discarded

    if (!credentials.passwordHash) {
        throw new Error('no password hash available after verification');
    }
    const passwordHash = ByteUtils.arrayToBuffer(credentials.passwordHash.getBinary());

    const prfSalt = globalThis.crypto.getRandomValues(new Uint8Array(32)).buffer;
    const { credentialId, vuk } = await enrollCredential(vault.uuid, prfSalt, userVerification);
    try {
        const wrappedPasswordHash = await SessionKey.wrapKeyMaterial(passwordHash, vuk);
        await saveBiometricRecord(vault.uuid, {
            credentialIdBase64: bufferToBase64(credentialId),
            prfSaltBase64: bufferToBase64(prfSalt),
            wrappedPasswordHashBase64: bufferToBase64(wrappedPasswordHash),
            enrolledAt: new Date().toISOString(),
            userVerification
        });
        prefetchedReads.delete(vault.uuid);
    } finally {
        // VUK and credentials out of scope (§6.2).
    }
}

// The WebAuthn ceremony right after this needs a still-fresh user gesture, which a Drive round
// trip can burn through — prefer a cache hit.
async function readForVerification(vault: ConfiguredVault): Promise<ArrayBuffer> {
    if (vault.provider === 'gdrive') {
        const cached = await readCacheBlob(vault.uuid);
        if (cached) {
            return cached;
        }
        const prefetched = prefetchedReads.get(vault.uuid);
        if (prefetched) {
            return prefetched;
        }
    }
    return createFileProvider(vault).read(vault.path ?? '');
}

export async function removeEnrollment(vaultUuid: string): Promise<void> {
    await removeBiometricRecord(vaultUuid);
}

// Unlock-time WebAuthn ceremony; returns unwrapped 32-byte password hash.
export async function unlockToPasswordHash(vaultUuid: string): Promise<ArrayBuffer> {
    const record = await getBiometricRecord(vaultUuid);
    if (!record) {
        throw new Error('no biometric credential enrolled for this vault');
    }
    const credentialId = base64ToBuffer(record.credentialIdBase64);
    const prfSalt = base64ToBuffer(record.prfSaltBase64);
    const wrappedPasswordHash = base64ToBuffer(record.wrappedPasswordHashBase64);

    const vuk = await getAssertionVuk(credentialId, prfSalt, record.userVerification ?? 'required');
    return SessionKey.unwrapKeyMaterial(wrappedPasswordHash, vuk, 32);
}
