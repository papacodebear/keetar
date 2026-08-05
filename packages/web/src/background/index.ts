import { ByteUtils } from '@keetar/core';
import { installArgon2 } from './argon2-wasm';
import { vaultSession } from './vault-session';
import { registerMessageHandler, type KeetarResponse } from './message-bus';
import { startKeepalive } from './keepalive';
import { idle } from '../platform';
import { matchEntries } from '../autofill/matcher';

// Entry point — registers listeners, initialises session (§2.4).

installArgon2();
startKeepalive();

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
        case 'GET_ENTRY_FIELD':
            return {
                ok: true,
                type: 'GET_ENTRY_FIELD',
                value: vaultSession.getEntryField(request.entryUuid, request.field)
            };
        case 'LOGIN_FORM_DETECTED': {
            // Background, not the content script, decides whether/what to
            // autofill (§5.1) — this just updates the toolbar badge with the
            // match count for the tab that sent it. Nothing to show if the
            // vault is locked (no entries to match against) or the tab's URL
            // isn't visible to us.
            const tabId = sender.tab?.id;
            const tabUrl = sender.tab?.url;
            if (tabId !== undefined && tabUrl && vaultSession.status === 'unlocked') {
                const matches = matchEntries(vaultSession.listEntries(), tabUrl);
                void chrome.action.setBadgeText({
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
        case 'GET_GROUP_TREE':
            return { ok: true, type: 'GET_GROUP_TREE', root: vaultSession.getGroupTree() };
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
    }
});

// Development console access (chrome://extensions → service worker →
// Inspect), matching the "browser console" allowance used since Phase 2 —
// handy for exercising the write path without going through the UI.
//   await __keetarDebug.vaultSession.createGroup(rootUuid, 'Test')
declare const self: { __keetarDebug?: unknown } & typeof globalThis;
self.__keetarDebug = { vaultSession };
