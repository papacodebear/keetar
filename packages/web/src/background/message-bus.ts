import type {
    EntryDetail,
    EntryFieldName,
    EntryFields,
    EntrySummary,
    GroupNode,
    GroupSummary,
    VaultSummary
} from './vault-session';
import type { MatchResult } from '../autofill/matcher';

// Typed message router between popup/manager/content/background (§2.4). Only
// the messages built so far exist — later phases (biometric unlock, import/
// export) add more variants to these unions rather than building a separate
// mechanism.

export type KeetarRequest =
    | { type: 'UNLOCK_VAULT'; uuid: string; password: string }
    // Popup already ran the WebAuthn ceremony and unwrapped the stored
    // password hash itself (§6.2) — passwordHashBase64 rather than
    // ArrayBuffer, same reasoning as ADD_ATTACHMENT/GET_ATTACHMENT below:
    // chrome.runtime.sendMessage's documented contract is a JSON-ifiable
    // payload, and ArrayBuffer isn't one.
    | { type: 'UNLOCK_VAULT_WITH_HASH'; uuid: string; passwordHashBase64: string }
    | { type: 'LOCK_VAULT' }
    | { type: 'GET_STATUS' }
    | { type: 'LIST_ENTRIES' }
    | { type: 'GET_ENTRY_FIELD'; entryUuid: string; field: EntryFieldName }
    | { type: 'LOGIN_FORM_DETECTED' }
    | { type: 'MATCH_ENTRIES'; tabUrl: string }
    | { type: 'CREATE_ENTRY'; groupUuid: string; fields: EntryFields }
    | { type: 'UPDATE_ENTRY'; entryUuid: string; fields: EntryFields }
    | { type: 'DELETE_ENTRY'; entryUuid: string }
    | { type: 'GET_GROUP_TREE' }
    | { type: 'GET_ENTRY_DETAIL'; entryUuid: string }
    | { type: 'MOVE_ENTRY'; entryUuid: string; toGroupUuid: string }
    | { type: 'CREATE_GROUP'; parentGroupUuid: string; name: string }
    | { type: 'RENAME_GROUP'; groupUuid: string; name: string }
    | { type: 'DELETE_GROUP'; groupUuid: string }
    | { type: 'ADD_ATTACHMENT'; entryUuid: string; name: string; dataBase64: string }
    | { type: 'REMOVE_ATTACHMENT'; entryUuid: string; name: string }
    | { type: 'GET_ATTACHMENT'; entryUuid: string; name: string };

export type KeetarResponse =
    | { ok: true; type: 'UNLOCK_VAULT'; summary: VaultSummary }
    | { ok: true; type: 'UNLOCK_VAULT_WITH_HASH'; summary: VaultSummary }
    | { ok: true; type: 'LOCK_VAULT' }
    | { ok: true; type: 'GET_STATUS'; status: 'locked' | 'unlocked' }
    | { ok: true; type: 'LIST_ENTRIES'; entries: EntrySummary[] }
    | { ok: true; type: 'GET_ENTRY_FIELD'; value: string }
    | { ok: true; type: 'LOGIN_FORM_DETECTED' }
    | { ok: true; type: 'MATCH_ENTRIES'; matches: MatchResult[] }
    | { ok: true; type: 'CREATE_ENTRY'; entry: EntrySummary }
    | { ok: true; type: 'UPDATE_ENTRY' }
    | { ok: true; type: 'DELETE_ENTRY' }
    | { ok: true; type: 'GET_GROUP_TREE'; root: GroupNode }
    | { ok: true; type: 'GET_ENTRY_DETAIL'; entry: EntryDetail }
    | { ok: true; type: 'MOVE_ENTRY' }
    | { ok: true; type: 'CREATE_GROUP'; group: GroupSummary }
    | { ok: true; type: 'RENAME_GROUP' }
    | { ok: true; type: 'DELETE_GROUP' }
    | { ok: true; type: 'ADD_ATTACHMENT' }
    | { ok: true; type: 'REMOVE_ATTACHMENT' }
    | { ok: true; type: 'GET_ATTACHMENT'; dataBase64: string }
    | { ok: false; error: string };

export type KeetarRequestHandler = (
    request: KeetarRequest,
    sender: chrome.runtime.MessageSender
) => Promise<KeetarResponse>;

/** Registers the background service worker's single message listener. */
export function registerMessageHandler(handle: KeetarRequestHandler): void {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        handle(message as KeetarRequest, sender)
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
