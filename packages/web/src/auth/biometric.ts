import { ByteUtils, Kdbx, KdbxCredentials, ProtectedValue, SessionKey } from '@keetar/core';
import { enrollCredential, getAssertionVuk } from './webauthn';
import {
    base64ToBuffer,
    bufferToBase64,
    getBiometricRecord,
    removeBiometricRecord,
    saveBiometricRecord
} from './biometric-store';
import { LocalFileProvider } from '../providers/local-file';

// Enroll + unlock orchestration; enrollment is scoped, ephemeral (§6.2, §8.1).

export async function isBiometricEnrolled(vaultUuid: string): Promise<boolean> {
    return (await getBiometricRecord(vaultUuid)) !== undefined;
}

export async function enroll(vaultUuid: string, password: string): Promise<void> {
    // Verify password before enrolling; typo fails now, not at first unlock (§6.2).
    const provider = new LocalFileProvider(vaultUuid);
    const data = await provider.read('');
    const credentials = new KdbxCredentials(ProtectedValue.fromString(password));
    await Kdbx.load(data, credentials); // throws if the password is wrong; result itself is discarded

    if (!credentials.passwordHash) {
        throw new Error('no password hash available after verification');
    }
    const passwordHash = ByteUtils.arrayToBuffer(credentials.passwordHash.getBinary());

    const prfSalt = globalThis.crypto.getRandomValues(new Uint8Array(32)).buffer;
    const { credentialId, vuk } = await enrollCredential(vaultUuid, prfSalt);
    try {
        const wrappedPasswordHash = await SessionKey.wrapKeyMaterial(passwordHash, vuk);
        await saveBiometricRecord(vaultUuid, {
            credentialIdBase64: bufferToBase64(credentialId),
            prfSaltBase64: bufferToBase64(prfSalt),
            wrappedPasswordHashBase64: bufferToBase64(wrappedPasswordHash),
            enrolledAt: new Date().toISOString()
        });
    } finally {
        // VUK and credentials out of scope (§6.2).
    }
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

    const vuk = await getAssertionVuk(credentialId, prfSalt);
    return SessionKey.unwrapKeyMaterial(wrappedPasswordHash, vuk, 32);
}
