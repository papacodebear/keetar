import {
    ByteUtils,
    parseBitwardenJson,
    parseCsv,
    parseOnePux,
    parseProtonPassJson,
    preloadPasswordStrength
} from '@keetar/core';
import { installArgon2 } from './argon2-wasm';
import { vaultSession } from './vault-session';
import { registerMessageHandler, type KeetarResponse } from './message-bus';
import { startKeepalive } from './keepalive';
import { action, idle } from '../platform';
import { matchEntries } from '../autofill/matcher';

// Entry point — registers listeners, initialises session (§2.4).

installArgon2();
startKeepalive();
void preloadPasswordStrength();

// Idle timeout (§3.4): lock on "locked" or "idle" state. 5 min default.
const DEFAULT_IDLE_TIMEOUT_SECONDS = 5 * 60;
idle.setDetectionInterval(DEFAULT_IDLE_TIMEOUT_SECONDS);
idle.onStateChanged((state) => {
    if ((state === 'idle' || state === 'locked') && vaultSession.status === 'unlocked') {
        vaultSession.lock();
    }
});

registerMessageHandler(async (request, sender): Promise<KeetarResponse> => {
    switch (request.type) {
        case 'UNLOCK_VAULT': {
            const summary = await vaultSession.unlock(request.uuid, request.password);
            return { ok: true, type: 'UNLOCK_VAULT', summary };
        }
        case 'UNLOCK_VAULT_WITH_HASH': {
            const passwordHash = ByteUtils.arrayToBuffer(ByteUtils.base64ToBytes(request.passwordHashBase64));
            const summary = await vaultSession.unlockWithHash(request.uuid, passwordHash);
            return { ok: true, type: 'UNLOCK_VAULT_WITH_HASH', summary };
        }
        case 'LOCK_VAULT':
            vaultSession.lock();
            return { ok: true, type: 'LOCK_VAULT' };
        case 'GET_STATUS':
            return { ok: true, type: 'GET_STATUS', status: vaultSession.status };
        case 'LIST_ENTRIES':
            return { ok: true, type: 'LIST_ENTRIES', entries: vaultSession.listEntries() };
        case 'SEARCH_ENTRIES':
            return { ok: true, type: 'SEARCH_ENTRIES', entries: vaultSession.searchEntries(request.query) };
        case 'GET_ENTRY_FIELD':
            return {
                ok: true,
                type: 'GET_ENTRY_FIELD',
                value: vaultSession.getEntryField(request.entryUuid, request.field)
            };
        case 'GET_ENTRY_TOTP': {
            const { code, remainingSeconds } = await vaultSession.getEntryTotp(request.entryUuid);
            return { ok: true, type: 'GET_ENTRY_TOTP', code, remainingSeconds };
        }
        case 'GET_PASSWORD_HEALTH':
            return {
                ok: true,
                type: 'GET_PASSWORD_HEALTH',
                report: await vaultSession.getPasswordHealth()
            };
        case 'LOGIN_FORM_DETECTED': {
            // Update toolbar badge with match count (background decides autofill logic).
            const tabId = sender.tab?.id;
            const tabUrl = sender.tab?.url;
            if (tabId !== undefined && tabUrl && vaultSession.status === 'unlocked') {
                const matches = matchEntries(vaultSession.listEntries(), tabUrl);
                action.setBadgeText({
                    tabId,
                    text: matches.length > 0 ? String(matches.length) : ''
                });
            }
            return { ok: true, type: 'LOGIN_FORM_DETECTED' };
        }
        case 'MATCH_ENTRIES':
            return {
                ok: true,
                type: 'MATCH_ENTRIES',
                matches: matchEntries(vaultSession.listEntries(), request.tabUrl)
            };
        case 'CREATE_ENTRY': {
            const entry = await vaultSession.createEntry(request.groupUuid, request.fields);
            return { ok: true, type: 'CREATE_ENTRY', entry };
        }
        case 'UPDATE_ENTRY':
            await vaultSession.updateEntry(request.entryUuid, request.fields);
            return { ok: true, type: 'UPDATE_ENTRY' };
        case 'DELETE_ENTRY':
            await vaultSession.deleteEntry(request.entryUuid);
            return { ok: true, type: 'DELETE_ENTRY' };
        case 'GET_GROUP_TREE': {
            const { root, recycleBinGroupUuid } = vaultSession.getGroupTree();
            return { ok: true, type: 'GET_GROUP_TREE', root, recycleBinGroupUuid };
        }
        case 'APPLY_AI_SORT': {
            const result = await vaultSession.applyAiSort(request.assignments);
            return { ok: true, type: 'APPLY_AI_SORT', ...result };
        }
        case 'GET_ENTRY_DETAIL':
            return {
                ok: true,
                type: 'GET_ENTRY_DETAIL',
                entry: vaultSession.getEntryDetail(request.entryUuid)
            };
        case 'MOVE_ENTRY':
            await vaultSession.moveEntry(request.entryUuid, request.toGroupUuid);
            return { ok: true, type: 'MOVE_ENTRY' };
        case 'CREATE_GROUP': {
            const group = await vaultSession.createGroup(request.parentGroupUuid, request.name);
            return { ok: true, type: 'CREATE_GROUP', group };
        }
        case 'RENAME_GROUP':
            await vaultSession.renameGroup(request.groupUuid, request.name);
            return { ok: true, type: 'RENAME_GROUP' };
        case 'DELETE_GROUP':
            await vaultSession.deleteGroup(request.groupUuid);
            return { ok: true, type: 'DELETE_GROUP' };
        case 'EMPTY_RECYCLE_BIN': {
            const result = await vaultSession.emptyRecycleBin();
            return { ok: true, type: 'EMPTY_RECYCLE_BIN', ...result };
        }
        case 'ADD_ATTACHMENT':
            await vaultSession.addAttachment(request.entryUuid, request.name, request.dataBase64);
            return { ok: true, type: 'ADD_ATTACHMENT' };
        case 'REMOVE_ATTACHMENT':
            await vaultSession.removeAttachment(request.entryUuid, request.name);
            return { ok: true, type: 'REMOVE_ATTACHMENT' };
        case 'GET_ATTACHMENT':
            return {
                ok: true,
                type: 'GET_ATTACHMENT',
                dataBase64: vaultSession.getAttachmentBase64(request.entryUuid, request.name)
            };
        case 'GET_ENTRY_CUSTOM_ICON':
            return {
                ok: true,
                type: 'GET_ENTRY_CUSTOM_ICON',
                dataBase64: vaultSession.getEntryCustomIconBase64(request.entryUuid)
            };
        case 'FETCH_FAVICON_ICON':
            await vaultSession.setCustomIconFromFavicon(request.entryUuid);
            return { ok: true, type: 'FETCH_FAVICON_ICON' };
        case 'FETCH_MISSING_FAVICONS': {
            const { updated, failed, skipped } = await vaultSession.fetchMissingFavicons();
            return { ok: true, type: 'FETCH_MISSING_FAVICONS', updated, failed, skipped };
        }
        case 'IMPORT_ENTRIES': {
            const bytes = ByteUtils.base64ToBytes(request.dataBase64);
            const records =
                request.format === 'onepassword'
                    ? parseOnePux(bytes)
                    : request.format === 'bitwarden'
                      ? parseBitwardenJson(ByteUtils.bytesToString(bytes))
                      : request.format === 'protonpass'
                        ? parseProtonPassJson(ByteUtils.bytesToString(bytes))
                        : parseCsv(ByteUtils.bytesToString(bytes));
            const { imported } = await vaultSession.importEntries(request.groupUuid, records);
            return { ok: true, type: 'IMPORT_ENTRIES', imported };
        }
        case 'EXPORT_VAULT':
            return { ok: true, type: 'EXPORT_VAULT', data: vaultSession.exportVault(request.format) };
        case 'OPEN_SECONDARY_VAULT': {
            const data = ByteUtils.arrayToBuffer(ByteUtils.base64ToBytes(request.dataBase64));
            const summary = await vaultSession.openSecondaryVault(data, request.password);
            return { ok: true, type: 'OPEN_SECONDARY_VAULT', summary };
        }
        case 'CLOSE_SECONDARY_VAULT':
            vaultSession.closeSecondaryVault();
            return { ok: true, type: 'CLOSE_SECONDARY_VAULT' };
        case 'PREVIEW_COMBINE': {
            const { conflicts, nonConflictingCount, identicalCount } = vaultSession.previewCombine();
            return { ok: true, type: 'PREVIEW_COMBINE', conflicts, nonConflictingCount, identicalCount };
        }
        case 'APPLY_COMBINE': {
            const { imported, merged, replaced } = await vaultSession.applyCombine(request.groupUuid, request.resolutions);
            return { ok: true, type: 'APPLY_COMBINE', imported, merged, replaced };
        }
    }
});

// Dev console access for testing (e.g. __keetarDebug.vaultSession.createGroup).
declare const self: { __keetarDebug?: unknown } & typeof globalThis;
self.__keetarDebug = { vaultSession };
