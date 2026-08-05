import type { PrfExtensionInput } from './prf';
import { extractVuk, isPrfEnabled } from './prf';

// WebAuthn credential registration + assertion (§6.2). Only callable from a
// document context with an active user gesture — same constraint as the
// File System Access picker (§4.2), and for the same underlying reason
// (browsers gate sensitive hardware/biometric prompts on real user intent).

export function isWebAuthnSupported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.credentials !== 'undefined';
}

export interface EnrollResult {
    credentialId: ArrayBuffer;
    vuk: ArrayBuffer;
}

/**
 * Registers a new platform/roaming authenticator credential for this vault
 * and evaluates PRF with `prfSalt` in the same ceremony where the
 * authenticator supports doing so during creation. Falls back to an
 * immediate follow-up assertion when it doesn't — not every authenticator
 * evaluates PRF at registration time even when it supports the extension.
 */
export async function enrollCredential(vaultUuid: string, prfSalt: ArrayBuffer): Promise<EnrollResult> {
    if (!isWebAuthnSupported()) {
        throw new Error('WebAuthn is not supported in this browser');
    }
    const userId = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(vaultUuid));
    const prfExtension: PrfExtensionInput = { prf: { eval: { first: prfSalt } } };
    const credential = (await navigator.credentials.create({
        publicKey: {
            challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
            rp: { name: 'Keetar' },
            user: { id: userId, name: 'Keetar vault', displayName: 'Keetar vault' },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256
            authenticatorSelection: { userVerification: 'required' },
            extensions: prfExtension as AuthenticationExtensionsClientInputs
        }
    })) as PublicKeyCredential | null;
    if (!credential) {
        throw new Error('credential creation was cancelled');
    }
    if (!isPrfEnabled(credential)) {
        throw new Error('this authenticator does not support the PRF extension');
    }
    let vuk = extractVuk(credential);
    if (!vuk) {
        // Supported, but not evaluated during creation — get it via an
        // immediate follow-up assertion instead (§6.2).
        vuk = await getAssertionVuk(credential.rawId, prfSalt);
    }
    return { credentialId: credential.rawId, vuk };
}

/** Runs the unlock-time assertion ceremony (§6.2) and returns the VUK. */
export async function getAssertionVuk(credentialId: ArrayBuffer, prfSalt: ArrayBuffer): Promise<ArrayBuffer> {
    if (!isWebAuthnSupported()) {
        throw new Error('WebAuthn is not supported in this browser');
    }
    const prfExtension: PrfExtensionInput = { prf: { eval: { first: prfSalt } } };
    const credential = (await navigator.credentials.get({
        publicKey: {
            challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
            allowCredentials: [{ id: credentialId, type: 'public-key' }],
            userVerification: 'required',
            extensions: prfExtension as AuthenticationExtensionsClientInputs
        }
    })) as PublicKeyCredential | null;
    if (!credential) {
        throw new Error('authentication was cancelled');
    }
    const vuk = extractVuk(credential);
    if (!vuk) {
        throw new Error('authenticator did not return a PRF result');
    }
    return vuk;
}
