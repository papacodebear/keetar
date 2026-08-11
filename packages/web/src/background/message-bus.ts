import type {
    CombineConflict,
    CombineResolution,
    EntryDetail,
    EntryFieldName,
    EntryFields,
    EntrySummary,
    GroupNode,
    GroupSummary,
    PasswordHealthReport,
    VaultSummary
} from './vault-session';
import type { MatchResult } from '../autofill/matcher';
import { SyncConflictError } from '../providers/opfs-cache';
import { runtime } from '../platform';

// Typed message router between popup/manager/content/background (§2.4).

export type KeetarRequest =
    | { type: 'UNLOCK_VAULT'; uuid: string; password: string }
    // Biometric unlock with pre-unwrapped hash (§6.2); use base64 for JSON-ifiable payload.
    | { type: 'UNLOCK_VAULT_WITH_HASH'; uuid: string; passwordHashBase64: string }
    | { type: 'LOCK_VAULT' }
    | { type: 'GET_STATUS' }
    | { type: 'LIST_ENTRIES' }
    | { type: 'GET_ENTRY_FIELD'; entryUuid: string; field: EntryFieldName }
    | { type: 'GET_ENTRY_TOTP'; entryUuid: string }
    | { type: 'GET_PASSWORD_HEALTH' }
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
    | { type: 'GET_ATTACHMENT'; entryUuid: string; name: string }
    | { type: 'GET_ENTRY_CUSTOM_ICON'; entryUuid: string }
    | { type: 'FETCH_FAVICON_ICON'; entryUuid: string }
    | { type: 'FETCH_MISSING_FAVICONS' }
    // Use dataBase64 uniformly for all formats (1PUX is zip, simplifes decode).
    | {
          type: 'IMPORT_ENTRIES';
          format: 'csv' | 'bitwarden' | 'onepassword' | 'protonpass';
          dataBase64: string;
          groupUuid: string;
      }
    | { type: 'EXPORT_VAULT'; format: 'csv' | 'xml' }
    // Combine vaults: dataBase64 + plaintext password (one-shot, not stored).
    | { type: 'OPEN_SECONDARY_VAULT'; dataBase64: string; password: string }
    | { type: 'CLOSE_SECONDARY_VAULT' }
    | { type: 'PREVIEW_COMBINE' }
    | { type: 'APPLY_COMBINE'; groupUuid: string; resolutions: Record<string, CombineResolution> };

export type KeetarResponse =
    | { ok: true; type: 'UNLOCK_VAULT'; summary: VaultSummary }
    | { ok: true; type: 'UNLOCK_VAULT_WITH_HASH'; summary: VaultSummary }
    | { ok: true; type: 'LOCK_VAULT' }
    | { ok: true; type: 'GET_STATUS'; status: 'locked' | 'unlocked' }
    | { ok: true; type: 'LIST_ENTRIES'; entries: EntrySummary[] }
    | { ok: true; type: 'GET_ENTRY_FIELD'; value: string }
    | { ok: true; type: 'GET_ENTRY_TOTP'; code: string; remainingSeconds: number }
    | { ok: true; type: 'GET_PASSWORD_HEALTH'; report: PasswordHealthReport }
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
    | { ok: true; type: 'GET_ENTRY_CUSTOM_ICON'; dataBase64: string }
    | { ok: true; type: 'FETCH_FAVICON_ICON' }
    | { ok: true; type: 'FETCH_MISSING_FAVICONS'; updated: number; failed: number; skipped: number }
    | { ok: true; type: 'IMPORT_ENTRIES'; imported: number }
    | { ok: true; type: 'EXPORT_VAULT'; data: string }
    | { ok: true; type: 'OPEN_SECONDARY_VAULT'; summary: VaultSummary }
    | { ok: true; type: 'CLOSE_SECONDARY_VAULT' }
    | {
          ok: true;
          type: 'PREVIEW_COMBINE';
          conflicts: CombineConflict[];
          nonConflictingCount: number;
          identicalCount: number;
      }
    | { ok: true; type: 'APPLY_COMBINE'; imported: number; merged: number; replaced: number }
    // code='SYNC_CONFLICT' distinguishes vault conflicts from other unlock failures.
    | { ok: false; error: string; code?: 'SYNC_CONFLICT' };

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
                    error: e instanceof Error ? e.message : String(e),
                    code: e instanceof SyncConflictError ? 'SYNC_CONFLICT' : undefined
                })
            )
            .then(sendResponse);
        return true; // response is sent asynchronously
    });
}

/** Sends a request from a UI surface (only usable from a document context). */
export function sendToBackground(request: KeetarRequest): Promise<KeetarResponse> {
    return runtime.sendMessage<KeetarResponse>(request);
}
