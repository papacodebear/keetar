import type { PrfExtensionInput } from './prf';
import { extractVuk, isPrfEnabled } from './prf';
import { isChrome } from '../platform';
import type { BiometricUserVerification } from './biometric-store';

// WebAuthn registration & assertion require document context + user gesture (§6.2).

// Firefox 150+ rejects the default moz-extension RP ID; this domain is ours and within host permissions.
// Chrome keeps its default, since changing an RP ID invalidates every credential enrolled under it.
const RP_ID = isChrome ? undefined : 'keetar.com';

export function isWebAuthnSupported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.credentials !== 'undefined';
}

export interface EnrollResult {
    credentialId: ArrayBuffer;
    vuk: ArrayBuffer;
}

// Register credential; evaluate PRF at creation if supported, else via follow-up assertion.
export async function enrollCredential(
    vaultUuid: string,
    prfSalt: ArrayBuffer,
    userVerification: BiometricUserVerification
): Promise<EnrollResult> {
    if (!isWebAuthnSupported()) {
        throw new Error('WebAuthn is not supported in this browser');
    }
    const userId = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(vaultUuid));
    const prfExtension: PrfExtensionInput = { prf: { eval: { first: prfSalt } } };
    let credential: PublicKeyCredential | null;
    try {
        credential = (await navigator.credentials.create({
            publicKey: {
                challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
                rp: { id: RP_ID, name: 'Keetar' },
                user: { id: userId, name: 'Keetar vault', displayName: 'Keetar vault' },
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256
                authenticatorSelection: { userVerification },
                extensions: prfExtension as AuthenticationExtensionsClientInputs
            }
        })) as PublicKeyCredential | null;
    } catch (e) {
        console.error('[keetar] navigator.credentials.create() failed', {
            error: e,
            name: e instanceof DOMException ? e.name : undefined,
            message: e instanceof Error ? e.message : String(e),
            origin: typeof location !== 'undefined' ? location.origin : undefined
        });
        if (!isChrome && e instanceof DOMException && e.name === 'SecurityError') {
            throw new Error('Biometric unlock requires Firefox 150 or later.');
        }
        throw e;
    }
    if (!credential) {
        throw new Error('credential creation was cancelled');
    }
    if (!isPrfEnabled(credential)) {
        throw new Error('this authenticator does not support the PRF extension');
    }
    let vuk = extractVuk(credential);
    if (!vuk) {
        // Not evaluated during creation; get via follow-up assertion (§6.2).
        vuk = await getAssertionVuk(credential.rawId, prfSalt, userVerification);
    }
    return { credentialId: credential.rawId, vuk };
}

// Assertion ceremony: returns VUK for unlock (§6.2).
export async function getAssertionVuk(
    credentialId: ArrayBuffer,
    prfSalt: ArrayBuffer,
    userVerification: BiometricUserVerification
): Promise<ArrayBuffer> {
    if (!isWebAuthnSupported()) {
        throw new Error('WebAuthn is not supported in this browser');
    }
    const prfExtension: PrfExtensionInput = { prf: { eval: { first: prfSalt } } };
    const credential = (await navigator.credentials.get({
        publicKey: {
            rpId: RP_ID,
            challenge: globalThis.crypto.getRandomValues(new Uint8Array(32)),
            allowCredentials: [{ id: credentialId, type: 'public-key' }],
            userVerification,
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
