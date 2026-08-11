import { useEffect, useMemo, useState } from 'react';
import { ByteUtils } from '@keetar/core';
import { sendToBackground } from '../../background/message-bus';
import type { EntryFieldName, EntrySummary } from '../../background/vault-session';
import {
    clearConfiguredVault,
    getConfiguredVault,
    type VaultBackend
} from '../../config/vault-config';
import type { FillCredentialsMessage } from '../../autofill/messages';
import { isBiometricEnrolled, unlockToPasswordHash } from '../../auth/biometric';
import { isWebAuthnSupported } from '../../auth/webauthn';
import { EntryIcon } from '../shared/EntryIcon';
import { tabs } from '../../platform';

// Quick access post-unlock: search, copy, fill (§8.1–8.2); also runs WebAuthn unlock ceremony (§6.2).

type ViewState =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'no-vault' }
    | {
          kind: 'locked';
          vaultUuid: string;
          vaultName: string;
          vaultProvider: VaultBackend;
          biometricEnrolled: boolean;
          error?: string;
          code?: 'SYNC_CONFLICT';
      }
    | {
          kind: 'unlocked';
          vaultName: string;
          vaultProvider: VaultBackend;
          entries: EntrySummary[];
          matchedUuids: Set<string>;
      };

export function App() {
    const [view, setView] = useState<ViewState>({ kind: 'loading' });

    useEffect(() => {
        void refresh();
    }, []);

    // Wrap all paths to show error instead of infinite "Loading…" on any failure.
    async function refresh(): Promise<void> {
        try {
            const configured = await getConfiguredVault();
            if (!configured) {
                setView({ kind: 'no-vault' });
                return;
            }
            const status = await sendToBackground({ type: 'GET_STATUS' });
            if (!status.ok) {
                setView({ kind: 'error', message: status.error });
                return;
            }
            if (status.type === 'GET_STATUS' && status.status === 'unlocked') {
                await loadEntries();
            } else {
                const biometricEnrolled = isWebAuthnSupported() && (await isBiometricEnrolled(configured.uuid));
                setView({
                    kind: 'locked',
                    vaultUuid: configured.uuid,
                    vaultName: configured.name,
                    vaultProvider: configured.provider,
                    biometricEnrolled
                });
            }
        } catch (e) {
            setView({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
        }
    }

    async function loadEntries(): Promise<void> {
        const response = await sendToBackground({ type: 'LIST_ENTRIES' });
        if (!response.ok || response.type !== 'LIST_ENTRIES') {
            throw new Error(!response.ok ? response.error : 'Could not load entries.');
        }
        const configured = await getConfiguredVault();
        const matchedUuids = await matchActiveTab();
        setView({
            kind: 'unlocked',
            vaultName: configured?.name ?? '',
            vaultProvider: configured?.provider ?? 'local-file',
            entries: response.entries,
            matchedUuids
        });
    }

    async function lockedError(
        vaultUuid: string,
        vaultName: string,
        vaultProvider: VaultBackend,
        error: string,
        code?: 'SYNC_CONFLICT'
    ): Promise<void> {
        const biometricEnrolled = isWebAuthnSupported() && (await isBiometricEnrolled(vaultUuid));
        setView({ kind: 'locked', vaultUuid, vaultName, vaultProvider, biometricEnrolled, error, code });
    }

    async function handleUnlock(password: string): Promise<void> {
        const configured = await getConfiguredVault();
        if (!configured) {
            setView({ kind: 'no-vault' });
            return;
        }
        try {
            const response = await sendToBackground({
                type: 'UNLOCK_VAULT',
                uuid: configured.uuid,
                password
            });
            if (response.ok) {
                await loadEntries();
            } else {
                await lockedError(configured.uuid, configured.name, configured.provider, response.error, response.code);
            }
        } catch (e) {
            await lockedError(
                configured.uuid,
                configured.name,
                configured.provider,
                e instanceof Error ? e.message : String(e)
            );
        }
    }

    async function handleBiometricUnlock(vaultUuid: string, vaultName: string, vaultProvider: VaultBackend): Promise<void> {
        try {
            const passwordHash = await unlockToPasswordHash(vaultUuid);
            const response = await sendToBackground({
                type: 'UNLOCK_VAULT_WITH_HASH',
                uuid: vaultUuid,
                passwordHashBase64: ByteUtils.bytesToBase64(new Uint8Array(passwordHash))
            });
            if (response.ok) {
                await loadEntries();
            } else {
                await lockedError(vaultUuid, vaultName, vaultProvider, response.error, response.code);
            }
        } catch (e) {
            await lockedError(vaultUuid, vaultName, vaultProvider, e instanceof Error ? e.message : String(e));
        }
    }

    async function handleLock(): Promise<void> {
        await sendToBackground({ type: 'LOCK_VAULT' });
        await refresh();
    }

    // Disconnect vault config without touching Drive/file; lock first (§8.1).
    async function handleDisconnect(): Promise<void> {
        await sendToBackground({ type: 'LOCK_VAULT' });
        await clearConfiguredVault();
        await refresh();
    }

    switch (view.kind) {
        case 'loading':
            return <p>Loading…</p>;
        case 'error':
            return (
                <div className="panel">
                    <p className="error">{view.message}</p>
                    <button type="button" onClick={() => void refresh()}>
                        Try again
                    </button>
                </div>
            );
        case 'no-vault':
            return <NoVaultView />;
        case 'locked':
            return (
                <LockedView
                    vaultName={view.vaultName}
                    vaultProvider={view.vaultProvider}
                    biometricEnrolled={view.biometricEnrolled}
                    error={view.error}
                    code={view.code}
                    onUnlock={handleUnlock}
                    onBiometricUnlock={() => handleBiometricUnlock(view.vaultUuid, view.vaultName, view.vaultProvider)}
                    onDisconnect={handleDisconnect}
                />
            );
        case 'unlocked':
            return (
                <UnlockedView
                    vaultName={view.vaultName}
                    vaultProvider={view.vaultProvider}
                    entries={view.entries}
                    matchedUuids={view.matchedUuids}
                    onLock={handleLock}
                    onDisconnect={handleDisconnect}
                />
            );
    }
}

function GearButton() {
    function openOptions(): void {
        chrome.runtime.openOptionsPage();
        window.close();
    }

    return (
        <button
            type="button"
            className="gear-button"
            title="Preferences"
            aria-label="Preferences"
            onClick={openOptions}
        >
            ⚙
        </button>
    );
}

function VaultStatusHeader({
    vaultName,
    vaultProvider,
    matchCount,
    onLock,
    onDisconnect
}: {
    vaultName: string;
    vaultProvider: VaultBackend;
    matchCount?: number;
    onLock?: () => Promise<void>;
    onDisconnect: () => Promise<void>;
}) {
    return (
        <div className="vault-status">
            <span className="vault-status-name">
                {vaultProvider === 'gdrive' ? 'Google Drive' : 'Local'}: {vaultName}
            </span>
            {matchCount !== undefined && (
                <span className="vault-status-matches">
                    {matchCount} {matchCount === 1 ? 'match' : 'matches'} on this page
                </span>
            )}
            {onLock && (
                <button
                    type="button"
                    className="lock-button"
                    title="Lock database"
                    aria-label="Lock database"
                    onClick={() => void onLock()}
                >
                    🔒
                </button>
            )}
            <button
                type="button"
                className="disconnect-button"
                title="Disconnect this database"
                aria-label="Disconnect this database"
                onClick={() => void onDisconnect()}
            >
                ✕
            </button>
            <GearButton />
        </div>
    );
}

// Match entries for active tab, not popup window (§5.4).
async function matchActiveTab(): Promise<Set<string>> {
    try {
        const [tab] = await tabs.query({ active: true, currentWindow: true });
        if (!tab?.url) {
            return new Set();
        }
        const response = await sendToBackground({ type: 'MATCH_ENTRIES', tabUrl: tab.url });
        if (response.ok && response.type === 'MATCH_ENTRIES') {
            return new Set(response.matches.map((m) => m.uuid));
        }
    } catch {
        // No active tab, or it's a page we have no access to (chrome://, etc.) — no matches, not an error.
    }
    return new Set();
}

async function fillActiveTab(
    username: string | undefined,
    password: string | undefined,
    otp: string | undefined
): Promise<void> {
    const [tab] = await tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) {
        return;
    }
    const message: FillCredentialsMessage = { type: 'FILL_CREDENTIALS', username, password, otp };
    await chrome.tabs.sendMessage(tab.id, message);
}

function NoVaultView() {
    function configureDatabase(): void {
        chrome.runtime.openOptionsPage();
        window.close();
    }

    return (
        <div className="panel">
            <div className="vault-status">
                <span className="vault-status-name">No vault configured</span>
            </div>
            <button type="button" onClick={configureDatabase}>
                Configure Database
            </button>
        </div>
    );
}

function LockedView({
    vaultName,
    vaultProvider,
    biometricEnrolled,
    error,
    code,
    onUnlock,
    onBiometricUnlock,
    onDisconnect
}: {
    vaultName: string;
    vaultProvider: VaultBackend;
    biometricEnrolled: boolean;
    error: string | undefined;
    code: 'SYNC_CONFLICT' | undefined;
    onUnlock: (password: string) => Promise<void>;
    onBiometricUnlock: () => Promise<void>;
    onDisconnect: () => Promise<void>;
}) {
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);

    async function submit(e: React.FormEvent): Promise<void> {
        e.preventDefault();
        setBusy(true);
        try {
            await onUnlock(password);
        } finally {
            setBusy(false);
        }
    }

    async function submitBiometric(): Promise<void> {
        setBusy(true);
        try {
            await onBiometricUnlock();
        } finally {
            setBusy(false);
        }
    }

    return (
        <form className="panel" onSubmit={(e) => void submit(e)}>
            <VaultStatusHeader vaultName={vaultName} vaultProvider={vaultProvider} onDisconnect={onDisconnect} />
            {biometricEnrolled && (
                <button type="button" onClick={() => void submitBiometric()} disabled={busy}>
                    Unlock with biometrics
                </button>
            )}
            <input
                type="password"
                autoFocus
                autoComplete="off"
                placeholder="Master password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
            />
            <button type="submit" disabled={busy || !password}>
                Unlock
            </button>
            {error && <p className="error">{error}</p>}
            {code === 'SYNC_CONFLICT' && (
                <button type="button" onClick={() => chrome.runtime.openOptionsPage()}>
                    Resolve in Options
                </button>
            )}
        </form>
    );
}

function UnlockedView({
    vaultName,
    vaultProvider,
    entries,
    matchedUuids,
    onLock,
    onDisconnect
}: {
    vaultName: string;
    vaultProvider: VaultBackend;
    entries: EntrySummary[];
    matchedUuids: Set<string>;
    onLock: () => Promise<void>;
    onDisconnect: () => Promise<void>;
}) {
    const [search, setSearch] = useState('');
    const [searchResults, setSearchResults] = useState<EntrySummary[] | undefined>(undefined);
    const [toast, setToast] = useState('');

    // Password matching runs in the background, not here — passwords never enter this state (§8.2).
    useEffect(() => {
        const term = search.trim();
        if (!term) {
            setSearchResults(undefined);
            return;
        }
        const handle = setTimeout(() => {
            void sendToBackground({ type: 'SEARCH_ENTRIES', query: term }).then((response) => {
                if (response.ok && response.type === 'SEARCH_ENTRIES') {
                    setSearchResults(response.entries);
                }
            });
        }, 150);
        return () => clearTimeout(handle);
    }, [search]);

    const filtered = useMemo(() => {
        const list = searchResults ?? entries;
        // Sort page matches first; search still works over all entries (§5.4).
        return [...list].sort((a, b) => {
            const aMatch = matchedUuids.has(a.uuid) ? 0 : 1;
            const bMatch = matchedUuids.has(b.uuid) ? 0 : 1;
            return aMatch - bMatch;
        });
    }, [entries, searchResults, matchedUuids]);

    function showToast(message: string): void {
        setToast(message);
        setTimeout(() => setToast(''), 1500);
    }

    async function copyField(entryUuid: string, field: EntryFieldName, label: string): Promise<void> {
        const response = await sendToBackground({ type: 'GET_ENTRY_FIELD', entryUuid, field });
        if (response.ok && response.type === 'GET_ENTRY_FIELD') {
            await navigator.clipboard.writeText(response.value);
            showToast(`${label} copied`);
        }
    }

    async function fill(entryUuid: string): Promise<void> {
        const [usernameRes, passwordRes] = await Promise.all([
            sendToBackground({ type: 'GET_ENTRY_FIELD', entryUuid, field: 'username' }),
            sendToBackground({ type: 'GET_ENTRY_FIELD', entryUuid, field: 'password' })
        ]);
        const username = usernameRes.ok && usernameRes.type === 'GET_ENTRY_FIELD' ? usernameRes.value : undefined;
        const password = passwordRes.ok && passwordRes.type === 'GET_ENTRY_FIELD' ? passwordRes.value : undefined;
        await fillActiveTab(username, password, undefined);
        showToast('Filled');
    }

    async function copyTotp(entryUuid: string): Promise<void> {
        const response = await sendToBackground({ type: 'GET_ENTRY_TOTP', entryUuid });
        if (response.ok && response.type === 'GET_ENTRY_TOTP') {
            await navigator.clipboard.writeText(response.code);
            showToast(`${response.code} copied`);
        }
    }

    async function fillTotp(entryUuid: string): Promise<void> {
        const response = await sendToBackground({ type: 'GET_ENTRY_TOTP', entryUuid });
        if (response.ok && response.type === 'GET_ENTRY_TOTP') {
            await fillActiveTab(undefined, undefined, response.code);
            showToast('OTP filled');
        }
    }

    // Manager owns editing; Popup only launches it (§8.1–8.2).
    function openManager(): void {
        void chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') });
        window.close();
    }

    return (
        <div className="panel">
            <VaultStatusHeader
                vaultName={vaultName}
                vaultProvider={vaultProvider}
                matchCount={matchedUuids.size}
                onLock={onLock}
                onDisconnect={onDisconnect}
            />
            <div className="toolbar">
                <input
                    type="text"
                    autoFocus
                    placeholder="Search"
                    title="Searches title, username, URL, and password"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
            </div>
            <button type="button" className="view-all-button" onClick={openManager}>
                View all entries &amp; groups
            </button>
            {toast && <p className="copy-toast">{toast}</p>}
            <ul className="entry-list">
                {filtered.map((entry) => (
                    <li key={entry.uuid} className={`entry-row${matchedUuids.has(entry.uuid) ? ' matched' : ''}`}>
                        <EntryIcon entryUuid={entry.uuid} icon={entry.icon} hasCustomIcon={entry.hasCustomIcon} size={18} />
                        <div className="entry-info">
                            <div className="entry-title">{entry.title || '(no title)'}</div>
                            <div className="entry-username">{entry.username}</div>
                        </div>
                        <div className="entry-actions">
                            <button type="button" onClick={() => void fill(entry.uuid)}>
                                Fill
                            </button>
                            <button type="button" onClick={() => void copyField(entry.uuid, 'username', 'Username')}>
                                User
                            </button>
                            <button type="button" onClick={() => void copyField(entry.uuid, 'password', 'Password')}>
                                Pass
                            </button>
                            {entry.hasTotp && (
                                <>
                                    <button type="button" onClick={() => void copyTotp(entry.uuid)}>
                                        OTP
                                    </button>
                                    <button type="button" onClick={() => void fillTotp(entry.uuid)}>
                                        Fill OTP
                                    </button>
                                </>
                            )}
                        </div>
                    </li>
                ))}
                {filtered.length === 0 && <li className="empty">No entries found.</li>}
            </ul>
        </div>
    );
}
