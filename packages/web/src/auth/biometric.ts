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

// Enrol + unlock flow orchestration (§6.2). Enrollment runs entirely in
// Options' own scoped, ephemeral unlock (§8.1) — it never touches the
// shared background session, and the Kdbx instance built here to verify the
// password exists only long enough to confirm success/failure.

export async function isBiometricEnrolled(vaultUuid: string): Promise<boolean> {
    return (await getBiometricRecord(vaultUuid)) !== undefined;
}

export async function enroll(vaultUuid: string, password: string): Promise<void> {
    // Verify the password is actually correct before enrolling anything —
    // a typo here should fail now, not silently surface later as a
    // confusing "incorrect password" the first time biometric unlock is
    // actually used (§6.2).
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
        // VUK and the verification credentials/password hash go out of scope
        // here — nothing left holding them beyond this function (§6.2 step 7).
    }
}

export async function removeEnrollment(vaultUuid: string): Promise<void> {
    await removeBiometricRecord(vaultUuid);
}

/** Runs the unlock-time WebAuthn ceremony and returns the unwrapped 32-byte password hash, ready to hand to background's UNLOCK_VAULT_WITH_HASH. */
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
