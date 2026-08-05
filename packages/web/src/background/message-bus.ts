import type { EntryFieldName, EntrySummary, VaultSummary } from './vault-session';

// Typed message router between popup/manager/content/background (§2.4). Only
// the messages built so far exist — later phases (autofill, Manager writes,
// biometric unlock) add more variants to these unions rather than building a
// separate mechanism.

export type KeetarRequest =
    | { type: 'UNLOCK_VAULT'; uuid: string; password: string }
    | { type: 'LOCK_VAULT' }
    | { type: 'GET_STATUS' }
    | { type: 'LIST_ENTRIES' }
    | { type: 'GET_ENTRY_FIELD'; entryUuid: string; field: EntryFieldName };

export type KeetarResponse =
    | { ok: true; type: 'UNLOCK_VAULT'; summary: VaultSummary }
    | { ok: true; type: 'LOCK_VAULT' }
    | { ok: true; type: 'GET_STATUS'; status: 'locked' | 'unlocked' }
    | { ok: true; type: 'LIST_ENTRIES'; entries: EntrySummary[] }
    | { ok: true; type: 'GET_ENTRY_FIELD'; value: string }
    | { ok: false; error: string };

export type KeetarRequestHandler = (request: KeetarRequest) => Promise<KeetarResponse>;

/** Registers the background service worker's single message listener. */
export function registerMessageHandler(handle: KeetarRequestHandler): void {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        handle(message as KeetarRequest)
            .catch(
                (e): KeetarResponse => ({
                    ok: false,
                    error: e instanceof Error ? e.message : String(e)
                })
            )
            .then(sendResponse);
        return true; // response is sent asynchronously
    });
}

/** Sends a request from a UI surface (only usable from a document context). */
export function sendToBackground(request: KeetarRequest): Promise<KeetarResponse> {
    return chrome.runtime.sendMessage(request);
}
