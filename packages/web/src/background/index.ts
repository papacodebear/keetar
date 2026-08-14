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
import { registerMessageHandler, type KeetarResponse, type PendingLoginPrompt } from './message-bus';
import { startKeepalive } from './keepalive';
import { action, idle, sessionStorage, tabs } from '../platform';
import { matchEntries } from '../autofill/matcher';
import { hasCompleteCapturedLogin, mergeCapturedLogin, type CapturedLogin } from './login-capture';

// Entry point — registers listeners, initialises session (§2.4).

installArgon2();
startKeepalive();
void preloadPasswordStrength();

// Idle timeout (§3.4): lock on "locked" or "idle" state. 5 min default.
const DEFAULT_IDLE_TIMEOUT_SECONDS = 5 * 60;
const PENDING_LOGIN_STORAGE_KEY = 'keetar.pendingLoginCaptures';
const PENDING_LOGIN_BADGE_COLOR = '#dc2626';
const DEFAULT_BADGE_COLOR = '#2563eb';
type PendingLoginCaptures = Record<string, CapturedLogin>;

// Remembers a Keetar-generated password just long enough to spot it in a later form
// submission (e.g. a change-password page), even with no username to match against.
const GENERATED_PASSWORD_STORAGE_KEY = 'keetar.recentGeneratedPassword';
const GENERATED_PASSWORD_EXPIRY_MS = 5 * 60 * 1000;
interface RecentGeneratedPassword {
    password: string;
    generatedAt: number;
}

async function getCapturedLogin(tabId: number): Promise<CapturedLogin | undefined> {
    return (await sessionStorage.get<PendingLoginCaptures>(PENDING_LOGIN_STORAGE_KEY))?.[String(tabId)];
}

async function captureLogin(tabId: number, login: CapturedLogin): Promise<void> {
    const captures = (await sessionStorage.get<PendingLoginCaptures>(PENDING_LOGIN_STORAGE_KEY)) ?? {};
    captures[String(tabId)] = mergeCapturedLogin(captures[String(tabId)], login);
    await sessionStorage.set(PENDING_LOGIN_STORAGE_KEY, captures);
}

async function clearCapturedLogin(tabId: number): Promise<void> {
    const captures = (await sessionStorage.get<PendingLoginCaptures>(PENDING_LOGIN_STORAGE_KEY)) ?? {};
    delete captures[String(tabId)];
    await sessionStorage.set(PENDING_LOGIN_STORAGE_KEY, captures);
}

async function rememberGeneratedPassword(password: string): Promise<void> {
    await sessionStorage.set(GENERATED_PASSWORD_STORAGE_KEY, { password, generatedAt: Date.now() });
}

async function getRecentGeneratedPassword(): Promise<string | undefined> {
    const stored = await sessionStorage.get<RecentGeneratedPassword>(GENERATED_PASSWORD_STORAGE_KEY);
    if (!stored || Date.now() - stored.generatedAt > GENERATED_PASSWORD_EXPIRY_MS) {
        return undefined;
    }
    return stored.password;
}

async function clearRecentGeneratedPassword(): Promise<void> {
    await sessionStorage.remove(GENERATED_PASSWORD_STORAGE_KEY);
}

// Which password an 'update' actually writes: the Keetar-generated one if the submission
// contained it (a change-password form), otherwise whatever the ordinary capture read.
function resolveCapturedPassword(capture: CapturedLogin, generated: string | undefined): string | undefined {
    if (generated && capture.passwordCandidates?.includes(generated)) {
        return generated;
    }
    return capture.password;
}

async function pendingLoginPrompt(tabId: number): Promise<PendingLoginPrompt | undefined> {
    const capture = await getCapturedLogin(tabId);
    if (!capture || vaultSession.status !== 'unlocked') {
        return undefined;
    }

    const entries = vaultSession.listEntries();
    const matchedEntries = matchEntries(entries, capture.url)
        .map((match) => entries.find((entry) => entry.uuid === match.uuid))
        .filter((entry): entry is (typeof entries)[number] => entry !== undefined);

    // Track B: a submitted password field matches one Keetar generated recently.
    const generated = await getRecentGeneratedPassword();
    if (generated && capture.passwordCandidates?.includes(generated)) {
        const staleMatches = matchedEntries.filter((entry) => !vaultSession.matchesEntryPassword(entry.uuid, generated));
        if (staleMatches.length > 0) {
            return {
                kind: 'update',
                title: capture.title || capture.url,
                url: capture.url,
                username: capture.username,
                updateCandidates: staleMatches.map((entry) => ({ uuid: entry.uuid, title: entry.title }))
            };
        }
    }

    // Track A: an ordinary login form's full username+password capture.
    if (!hasCompleteCapturedLogin(capture)) {
        return undefined;
    }
    if (matchedEntries.some((entry) => vaultSession.matchesEntryCredentials(entry.uuid, capture.username, capture.password))) {
        await clearCapturedLogin(tabId);
        return undefined;
    }

    return {
        kind: matchedEntries.length > 0 ? 'update' : 'save',
        title: capture.title || capture.url,
        url: capture.url,
        username: capture.username,
        updateCandidates: matchedEntries.map((entry) => ({ uuid: entry.uuid, title: entry.title }))
    };
}

async function updateTabBadge(tabId: number, tabUrl: string): Promise<void> {
    const prompt = await pendingLoginPrompt(tabId);
    if (prompt) {
        await action.setBadgeBackgroundColor({ tabId, color: PENDING_LOGIN_BADGE_COLOR });
        await action.setBadgeText({ tabId, text: '!' });
        return;
    }
    const matches = vaultSession.status === 'unlocked' ? matchEntries(vaultSession.listEntries(), tabUrl) : [];
    await action.setBadgeBackgroundColor({ tabId, color: DEFAULT_BADGE_COLOR });
    await action.setBadgeText({ tabId, text: matches.length > 0 ? String(matches.length) : '' });
}

tabs.onRemoved((tabId) => {
    void clearCapturedLogin(tabId);
});

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
        case 'GET_DUPLICATE_CREDENTIAL_GROUPS':
            return {
                ok: true,
                type: 'GET_DUPLICATE_CREDENTIAL_GROUPS',
                groups: vaultSession.getDuplicateCredentialGroups()
            };
        case 'REMOVE_DUPLICATE_ENTRIES':
            return {
                ok: true,
                type: 'REMOVE_DUPLICATE_ENTRIES',
                removed: await vaultSession.removeDuplicateEntries(request.keepEntryUuids)
            };
        case 'CAPTURE_LOGIN_CREDENTIALS': {
            const tabId = sender.tab?.id;
            if (tabId !== undefined && vaultSession.status === 'unlocked') {
                await captureLogin(tabId, request);
                await updateTabBadge(tabId, sender.tab?.url ?? request.url);
            }
            return { ok: true, type: 'CAPTURE_LOGIN_CREDENTIALS' };
        }
        case 'CAPTURE_GENERATED_PASSWORD': {
            if (vaultSession.status === 'unlocked') {
                await rememberGeneratedPassword(request.password);
            }
            return { ok: true, type: 'CAPTURE_GENERATED_PASSWORD' };
        }
        case 'GET_PENDING_LOGIN_PROMPT':
            return { ok: true, type: 'GET_PENDING_LOGIN_PROMPT', prompt: await pendingLoginPrompt(request.tabId) };
        case 'APPLY_PENDING_LOGIN_PROMPT': {
            if (request.action === 'dismiss') {
                await clearCapturedLogin(request.tabId);
                await action.setBadgeBackgroundColor({ tabId: request.tabId, color: DEFAULT_BADGE_COLOR });
                await action.setBadgeText({ tabId: request.tabId, text: '' });
                return { ok: true, type: 'APPLY_PENDING_LOGIN_PROMPT' };
            }
            const capture = await getCapturedLogin(request.tabId);
            const prompt = await pendingLoginPrompt(request.tabId);
            if (!capture || !prompt) {
                throw new Error('there is no pending login to save');
            }
            if (request.action === 'save') {
                if (prompt.kind !== 'save' || !hasCompleteCapturedLogin(capture)) {
                    throw new Error('choose an existing entry to update');
                }
                await vaultSession.createEntryFromCapturedLogin(capture);
            } else {
                const generated = await getRecentGeneratedPassword();
                const password = resolveCapturedPassword(capture, generated);
                if (
                    prompt.kind !== 'update' ||
                    !password ||
                    !request.entryUuid ||
                    !prompt.updateCandidates.some((entry) => entry.uuid === request.entryUuid)
                ) {
                    throw new Error('choose an entry that matches this page');
                }
                await vaultSession.updateEntryFromCapturedLogin(request.entryUuid, { ...capture, password });
                await clearRecentGeneratedPassword();
            }
            await clearCapturedLogin(request.tabId);
            await action.setBadgeBackgroundColor({ tabId: request.tabId, color: DEFAULT_BADGE_COLOR });
            await action.setBadgeText({ tabId: request.tabId, text: '' });
            return { ok: true, type: 'APPLY_PENDING_LOGIN_PROMPT' };
        }
        case 'LOGIN_FORM_DETECTED': {
            // Update toolbar badge with match count (background decides autofill logic).
            const tabId = sender.tab?.id;
            const tabUrl = sender.tab?.url;
            if (tabId !== undefined && tabUrl) {
                await updateTabBadge(tabId, tabUrl);
            }
            return { ok: true, type: 'LOGIN_FORM_DETECTED' };
        }
        case 'GET_PAGE_ENTRY_MATCHES': {
            const tabUrl = sender.tab?.url;
            if (!tabUrl) {
                return { ok: true, type: 'GET_PAGE_ENTRY_MATCHES', matches: [] };
            }
            const entries = vaultSession.listEntries();
            const entryTitles = new Map(entries.map((entry) => [entry.uuid, entry.title]));
            return {
                ok: true,
                type: 'GET_PAGE_ENTRY_MATCHES',
                matches: matchEntries(entries, tabUrl).map((match) => ({
                    uuid: match.uuid,
                    title: entryTitles.get(match.uuid) ?? ''
                }))
            };
        }
        case 'FILL_PAGE_ENTRY': {
            const tabId = sender.tab?.id;
            if (tabId === undefined) {
                throw new Error('entry can only be filled from a browser tab');
            }
            const [username, password] = [
                vaultSession.getEntryField(request.entryUuid, 'username'),
                vaultSession.getEntryField(request.entryUuid, 'password')
            ];
            await tabs.sendMessage(tabId, { type: 'FILL_CREDENTIALS', username, password });
            return { ok: true, type: 'FILL_PAGE_ENTRY' };
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

// Dev console access for testing (e.g. __keetarDebug.vaultSession.createGroup) — dev builds only.
declare const self: { __keetarDebug?: unknown } & typeof globalThis;
if (process.env.NODE_ENV !== 'production') {
    self.__keetarDebug = { vaultSession };
}
