import { ByteUtils } from '@keetar/core';
import { base64UrlDecode, base64UrlEncode, buildClientDataJson } from './webauthn-crypto';
import {
    PAGE_TO_RELAY_SOURCE,
    RELAY_ENABLE_SOURCE,
    RELAY_TO_PAGE_SOURCE,
    type PageToRelayMessage,
    type RelayEnableMessage,
    type RelayToPageMessage
} from './bridge-protocol';

let interceptionEnabled = false;
window.addEventListener('message', (event) => {
    const data = event.data as RelayEnableMessage | undefined;
    if (event.source === window && data?.source === RELAY_ENABLE_SOURCE) {
        interceptionEnabled = data.enabled;
    }
});

// MAIN-world monkey-patch of navigator.credentials — no extension API exists to register as a
// WebAuthn picker option, so this is the only interception point (§ Context). No crypto here;
// only captures the real call and relays it to the isolated-world content script.

const ES256_ALG = -7;

const originalCreate = navigator.credentials.create.bind(navigator.credentials);
const originalGet = navigator.credentials.get.bind(navigator.credentials);

function toUint8Array(source: BufferSource): Uint8Array {
    return source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

function supportsEs256(params: PublicKeyCredentialParameters[] | undefined): boolean {
    return !params || params.some((p) => p.alg === ES256_ALG);
}

function sendToRelay(message: PageToRelayMessage): Promise<RelayToPageMessage> {
    return new Promise((resolve) => {
        function onMessage(event: MessageEvent): void {
            const data = event.data as RelayToPageMessage | undefined;
            if (event.source !== window || data?.source !== RELAY_TO_PAGE_SOURCE || data.requestId !== message.requestId) {
                return;
            }
            window.removeEventListener('message', onMessage);
            resolve(data);
        }
        window.addEventListener('message', onMessage);
        window.postMessage(message, window.location.origin);
    });
}

function buildCredential(id: string, rawId: ArrayBuffer, response: object, responseProto: object): Credential {
    Object.setPrototypeOf(response, responseProto);
    const credential = {
        id,
        rawId,
        type: 'public-key',
        response,
        authenticatorAttachment: 'platform',
        getClientExtensionResults: () => ({})
    };
    Object.setPrototypeOf(credential, PublicKeyCredential.prototype);
    return credential as unknown as Credential;
}

async function interceptedCreate(options: CredentialCreationOptions | undefined): Promise<Credential | null> {
    const publicKey = options?.publicKey;
    if (!interceptionEnabled || !publicKey || !supportsEs256(publicKey.pubKeyCredParams) || typeof PublicKeyCredential === 'undefined') {
        return originalCreate(options);
    }

    const rpId = publicKey.rp.id ?? window.location.hostname;
    const origin = window.location.origin;
    const challenge = toUint8Array(publicKey.challenge);
    const userId = toUint8Array(publicKey.user.id);

    const response = await sendToRelay({
        source: PAGE_TO_RELAY_SOURCE,
        requestId: crypto.randomUUID(),
        kind: 'create',
        create: {
            rpId,
            rpName: publicKey.rp.name ?? rpId,
            userIdBase64Url: base64UrlEncode(userId),
            userName: publicKey.user.name,
            userDisplayName: publicKey.user.displayName,
            challengeBase64Url: base64UrlEncode(challenge)
        }
    });
    if (!response.ok || !response.create) {
        throw new DOMException(response.error ?? 'the request was not allowed', 'NotAllowedError');
    }

    const rawId = base64UrlDecode(response.create.credentialIdBase64Url).buffer as ArrayBuffer;
    const clientDataJSON = buildClientDataJson({ type: 'webauthn.create', challenge, origin }).buffer as ArrayBuffer;
    return buildCredential(
        response.create.credentialIdBase64Url,
        rawId,
        {
            clientDataJSON,
            attestationObject: ByteUtils.base64ToBytes(response.create.attestationObjectBase64).buffer,
            getTransports: () => ['internal']
        },
        (window as unknown as { AuthenticatorAttestationResponse: { prototype: object } })
            .AuthenticatorAttestationResponse.prototype
    );
}

async function interceptedGet(options: CredentialRequestOptions | undefined): Promise<Credential | null> {
    const publicKey = options?.publicKey;
    if (!interceptionEnabled || !publicKey || typeof PublicKeyCredential === 'undefined') {
        return originalGet(options);
    }

    const rpId = publicKey.rpId ?? window.location.hostname;
    const origin = window.location.origin;
    const challenge = toUint8Array(publicKey.challenge);

    const response = await sendToRelay({
        source: PAGE_TO_RELAY_SOURCE,
        requestId: crypto.randomUUID(),
        kind: 'get',
        get: {
            rpId,
            challengeBase64Url: base64UrlEncode(challenge),
            allowCredentialIds: publicKey.allowCredentials?.map((c) => base64UrlEncode(toUint8Array(c.id)))
        }
    });
    if (!response.ok || !response.get) {
        throw new DOMException(response.error ?? 'the request was not allowed', 'NotAllowedError');
    }

    const rawId = base64UrlDecode(response.get.credentialIdBase64Url).buffer as ArrayBuffer;
    const clientDataJSON = buildClientDataJson({ type: 'webauthn.get', challenge, origin }).buffer as ArrayBuffer;
    return buildCredential(
        response.get.credentialIdBase64Url,
        rawId,
        {
            clientDataJSON,
            authenticatorData: ByteUtils.base64ToBytes(response.get.authenticatorDataBase64).buffer,
            signature: ByteUtils.base64ToBytes(response.get.signatureBase64).buffer,
            userHandle: base64UrlDecode(response.get.userHandleBase64Url).buffer
        },
        (window as unknown as { AuthenticatorAssertionResponse: { prototype: object } }).AuthenticatorAssertionResponse
            .prototype
    );
}

navigator.credentials.create = interceptedCreate as typeof navigator.credentials.create;
navigator.credentials.get = interceptedGet as typeof navigator.credentials.get;
