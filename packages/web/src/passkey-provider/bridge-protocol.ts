// postMessage protocol between the MAIN-world page shim and the isolated-world content relay.
// Both run in the same window, so every listener must check event.source === window (§ Security).

export const PAGE_TO_RELAY_SOURCE = 'keetar-passkey-page';
export const RELAY_TO_PAGE_SOURCE = 'keetar-passkey-relay';
export const RELAY_ENABLE_SOURCE = 'keetar-passkey-enable';

// Interception is off by default (§ Scope); the relay tells the shim once it knows the real
// setting, since MAIN-world code can't read chrome.storage itself.
export interface RelayEnableMessage {
    source: typeof RELAY_ENABLE_SOURCE;
    enabled: boolean;
}

export interface PasskeyCreateOptions {
    rpId: string;
    rpName: string;
    userIdBase64Url: string;
    userName: string;
    userDisplayName: string;
    challengeBase64Url: string;
}

export interface PasskeyGetOptions {
    rpId: string;
    challengeBase64Url: string;
    allowCredentialIds?: string[];
}

export interface PageToRelayMessage {
    source: typeof PAGE_TO_RELAY_SOURCE;
    requestId: string;
    kind: 'create' | 'get';
    create?: PasskeyCreateOptions;
    get?: PasskeyGetOptions;
}

export interface RelayToPageMessage {
    source: typeof RELAY_TO_PAGE_SOURCE;
    requestId: string;
    ok: boolean;
    error?: string;
    // "Base64" fields are plain base64 (blob transport, like the rest of the codebase);
    // "Base64Url" fields are base64url — the literal encoding WebAuthn requires for credential ids.
    create?: {
        credentialIdBase64Url: string;
        attestationObjectBase64: string;
    };
    get?: {
        credentialIdBase64Url: string;
        authenticatorDataBase64: string;
        signatureBase64: string;
        userHandleBase64Url: string;
    };
}

/** Posted by the passkey-prompt iframe directly to `window.parent` once the user has decided. */
export interface PromptToRelayMessage {
    source: 'keetar-passkey-prompt';
    requestId: string;
    ok: boolean;
    error?: string;
    create?: RelayToPageMessage['create'];
    get?: RelayToPageMessage['get'];
}
