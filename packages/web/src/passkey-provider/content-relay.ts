import { ByteUtils } from '@keetar/core';
import { sendToBackground, type PendingPasskeyRequest } from '../background/message-bus';
import { isPasskeyInterceptionEnabled } from '../config/passkey-config';
import { base64UrlDecode } from './webauthn-crypto';
import {
    PAGE_TO_RELAY_SOURCE,
    RELAY_ENABLE_SOURCE,
    RELAY_TO_PAGE_SOURCE,
    type PageToRelayMessage,
    type PromptToRelayMessage,
    type RelayToPageMessage
} from './bridge-protocol';

// Isolated-world bridge: relays the MAIN-world shim's captured request to the background
// (§ Architecture step 2), shows the passkey-prompt iframe, and relays its result back.

let overlayHost: HTMLDivElement | undefined;
let overlayIframe: HTMLIFrameElement | undefined;
let activePageRequestId: string | undefined;

function base64UrlToBase64(value: string): string {
    return ByteUtils.bytesToBase64(base64UrlDecode(value));
}

function buildPendingRequest(message: PageToRelayMessage): PendingPasskeyRequest | undefined {
    if (message.kind === 'create' && message.create) {
        return {
            kind: 'create',
            rpId: message.create.rpId,
            origin: window.location.origin,
            challengeBase64: base64UrlToBase64(message.create.challengeBase64Url),
            create: {
                userName: message.create.userName,
                userDisplayName: message.create.userDisplayName,
                userHandleBase64Url: message.create.userIdBase64Url
            }
        };
    }
    if (message.kind === 'get' && message.get) {
        return {
            kind: 'get',
            rpId: message.get.rpId,
            origin: window.location.origin,
            challengeBase64: base64UrlToBase64(message.get.challengeBase64Url),
            get: { allowCredentialIds: message.get.allowCredentialIds }
        };
    }
    return undefined;
}

function respondToPage(message: RelayToPageMessage): void {
    window.postMessage(message, window.location.origin);
}

function cancelActiveRequest(): void {
    if (activePageRequestId) {
        respondToPage({ source: RELAY_TO_PAGE_SOURCE, requestId: activePageRequestId, ok: false, error: 'cancelled' });
    }
    activePageRequestId = undefined;
    removeOverlay();
}

function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
        cancelActiveRequest();
    }
}

function removeOverlay(): void {
    overlayHost?.remove();
    overlayHost = undefined;
    overlayIframe = undefined;
    window.removeEventListener('keydown', onKeyDown);
}

function showOverlay(backgroundRequestId: string): void {
    removeOverlay();
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    const backdrop = document.createElement('div');
    Object.assign(backdrop.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483647',
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
    });
    backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) {
            cancelActiveRequest();
        }
    });
    const iframe = document.createElement('iframe');
    iframe.src = `${chrome.runtime.getURL('passkey-prompt/passkey-prompt.html')}?requestId=${encodeURIComponent(backgroundRequestId)}`;
    iframe.title = 'Keetar passkey';
    Object.assign(iframe.style, {
        width: '360px',
        height: '420px',
        border: '0',
        borderRadius: '8px',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.35)',
        background: '#fff'
    });
    backdrop.append(iframe);
    shadow.append(backdrop);
    document.documentElement.append(host);
    overlayHost = host;
    overlayIframe = iframe;
    window.addEventListener('keydown', onKeyDown);
}

async function handlePageRequest(message: PageToRelayMessage): Promise<void> {
    activePageRequestId = message.requestId;
    const request = buildPendingRequest(message);
    if (!request) {
        respondToPage({ source: RELAY_TO_PAGE_SOURCE, requestId: message.requestId, ok: false, error: 'malformed request' });
        activePageRequestId = undefined;
        return;
    }
    const stashed = await sendToBackground({ type: 'STASH_PASSKEY_REQUEST', request });
    if (!stashed.ok || stashed.type !== 'STASH_PASSKEY_REQUEST') {
        respondToPage({
            source: RELAY_TO_PAGE_SOURCE,
            requestId: message.requestId,
            ok: false,
            error: 'could not start the passkey request'
        });
        activePageRequestId = undefined;
        return;
    }
    showOverlay(stashed.requestId);
}

function handlePromptResult(event: MessageEvent): void {
    const data = event.data as PromptToRelayMessage | undefined;
    if (!overlayIframe || event.source !== overlayIframe.contentWindow || data?.source !== 'keetar-passkey-prompt') {
        return;
    }
    if (!activePageRequestId) {
        return;
    }
    respondToPage({
        source: RELAY_TO_PAGE_SOURCE,
        requestId: activePageRequestId,
        ok: data.ok,
        error: data.error,
        create: data.create,
        get: data.get
    });
    activePageRequestId = undefined;
    removeOverlay();
}

export function initPasskeyContentRelay(): void {
    window.addEventListener('message', (event) => {
        const data = event.data as { source?: string } | undefined;
        if (event.source === window && data?.source === PAGE_TO_RELAY_SOURCE) {
            void handlePageRequest(event.data as PageToRelayMessage);
            return;
        }
        handlePromptResult(event);
    });

    void isPasskeyInterceptionEnabled().then((enabled) => {
        window.postMessage({ source: RELAY_ENABLE_SOURCE, enabled }, window.location.origin);
    });
}
