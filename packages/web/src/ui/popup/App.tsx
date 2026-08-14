import { useEffect, useRef, useState } from 'react';
import { ByteUtils } from '@keetar/core';
import { sendToBackground, type PendingLoginPrompt } from '../../background/message-bus';
import type { EntryFieldName, EntrySummary } from '../../background/vault-session';
import {
    clearConfiguredVault,
    getConfiguredVault,
    type VaultBackend
} from '../../config/vault-config';
import type { ContentScriptMessage, FillCredentialsMessage } from '../../autofill/messages';
import { isBiometricEnrolled, unlockToPasswordHash } from '../../auth/biometric';
import { isWebAuthnSupported } from '../../auth/webauthn';
import { EntryIcon } from '../shared/EntryIcon';
import { VaultProviderIcon } from '../shared/VaultProviderIcon';
import { PasswordGeneratorPanel } from '../shared/PasswordGeneratorPanel';
import { tabs } from '../../platform';
import { ensureVaultFilePermission } from '../../providers/local-file';

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
          pendingLoginPrompt: PendingLoginPrompt | undefined;
          activeTabId: number | undefined;
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
        const [tab] = await tabs.query({ active: true, currentWindow: true });
        const pendingResponse =
            tab?.id === undefined
                ? undefined
                : await sendToBackground({ type: 'GET_PENDING_LOGIN_PROMPT', tabId: tab.id });
        setView({
            kind: 'unlocked',
            vaultName: configured?.name ?? '',
            vaultProvider: configured?.provider ?? 'local-file',
            entries: response.entries,
            matchedUuids,
            pendingLoginPrompt:
                pendingResponse?.ok && pendingResponse.type === 'GET_PENDING_LOGIN_PROMPT'
                    ? pendingResponse.prompt
                    : undefined,
            activeTabId: tab?.id
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

    async function handleUnlock(
        password: string,
        vaultUuid: string,
        vaultName: string,
        vaultProvider: VaultBackend
    ): Promise<void> {
        try {
            if (vaultProvider === 'local-file') {
                await ensureVaultFilePermission(vaultUuid);
            }
            const response = await sendToBackground({
                type: 'UNLOCK_VAULT',
                uuid: vaultUuid,
                password
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

    async function handleBiometricUnlock(vaultUuid: string, vaultName: string, vaultProvider: VaultBackend): Promise<void> {
        try {
            if (vaultProvider === 'local-file') {
                await ensureVaultFilePermission(vaultUuid);
            }
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
                    onUnlock={(password) => handleUnlock(password, view.vaultUuid, view.vaultName, view.vaultProvider)}
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
                    pendingLoginPrompt={view.pendingLoginPrompt}
                    activeTabId={view.activeTabId}
                    onLoginPromptHandled={loadEntries}
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
            <VaultProviderIcon provider={vaultProvider} />
            <span className="vault-status-name">{vaultName}</span>
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

async function redetectActiveTab(): Promise<void> {
    const [tab] = await tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) {
        return;
    }
    const message: ContentScriptMessage = { type: 'REDETECT_LOGIN_FORM' };
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
    const passwordInput = useRef<HTMLInputElement>(null);

    useEffect(() => {
        passwordInput.current?.focus();
    }, []);

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
                ref={passwordInput}
                type="password"
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
    pendingLoginPrompt,
    activeTabId,
    onLoginPromptHandled,
    onLock,
    onDisconnect
}: {
    vaultName: string;
    vaultProvider: VaultBackend;
    entries: EntrySummary[];
    matchedUuids: Set<string>;
    pendingLoginPrompt: PendingLoginPrompt | undefined;
    activeTabId: number | undefined;
    onLoginPromptHandled: () => Promise<void>;
    onLock: () => Promise<void>;
    onDisconnect: () => Promise<void>;
}) {
    const [toast, setToast] = useState('');
    const [showGenerator, setShowGenerator] = useState(false);
    const matchedEntries = entries.filter((entry) => matchedUuids.has(entry.uuid));

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

    function rememberGeneratedPassword(value: string): void {
        void sendToBackground({ type: 'CAPTURE_GENERATED_PASSWORD', password: value });
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

    async function redetectFields(): Promise<void> {
        try {
            await redetectActiveTab();
            showToast('Checked for login fields');
        } catch {
            showToast('Cannot inspect this page');
        }
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

    // Manager owns editing; reuse its existing tab when possible (§8.1–8.2).
    async function openManager(entryUuid?: string): Promise<void> {
        await openManagerTab(entryUuid);
        window.close();
    }

    async function openManagerTab(entryUuid?: string): Promise<void> {
        const managerUrl = chrome.runtime.getURL('manager/manager.html');
        const url = entryUuid ? `${managerUrl}?${new URLSearchParams({ entry: entryUuid })}` : managerUrl;
        const openTabs = await tabs.query({});
        const existingManagerTab = openTabs.find((tab) => tab.url?.split(/[?#]/, 1)[0] === managerUrl);
        if (existingManagerTab?.id !== undefined) {
            await tabs.update(existingManagerTab.id, { active: true, url });
            return;
        }
        await chrome.tabs.create({ url });
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
            {pendingLoginPrompt && activeTabId !== undefined && (
                <PendingLoginPromptCard
                    prompt={pendingLoginPrompt}
                    tabId={activeTabId}
                    onHandled={onLoginPromptHandled}
                />
            )}
            <div className="toolbar">
                <button type="button" className="view-all-button" onClick={() => void openManager()}>
                    View all entries &amp; groups
                </button>
                {matchedUuids.size > 0 && (
                    <button type="button" onClick={() => void redetectFields()} title="Detect login fields on this page">
                        Detect fields
                    </button>
                )}
                <button type="button" onClick={() => setShowGenerator((v) => !v)} title="Generate a password">
                    🎲 Generate
                </button>
            </div>
            {showGenerator && (
                <div className="password-generator-overlay">
                    <PasswordGeneratorPanel
                        onClose={() => setShowGenerator(false)}
                        onCopy={rememberGeneratedPassword}
                    />
                </div>
            )}
            {toast && <p className="copy-toast">{toast}</p>}
            <ul className="entry-list">
                {matchedEntries.map((entry) => (
                    <li key={entry.uuid} className="entry-row matched">
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
                            <button
                                type="button"
                                title="Open in Manage"
                                aria-label={`Open ${entry.title || 'entry'} in Manage`}
                                onClick={() => void openManager(entry.uuid)}
                            >
                                …
                            </button>
                        </div>
                    </li>
                ))}
                {matchedEntries.length === 0 && <li className="empty">No entries match this page.</li>}
            </ul>
        </div>
    );
}

function PendingLoginPromptCard({
    prompt,
    tabId,
    onHandled
}: {
    prompt: PendingLoginPrompt;
    tabId: number;
    onHandled: () => Promise<void>;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);

    async function apply(action: 'save' | 'update' | 'dismiss', entryUuid?: string): Promise<void> {
        setBusy(true);
        setError(undefined);
        try {
            const response = await sendToBackground({
                type: 'APPLY_PENDING_LOGIN_PROMPT',
                tabId,
                action,
                entryUuid
            });
            if (!response.ok) {
                setError(response.error);
                return;
            }
            await onHandled();
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="login-prompt">
            <strong>{prompt.kind === 'save' ? 'Save login?' : 'Update saved login?'}</strong>
            <span className="login-prompt-detail">
                {prompt.title}
                {prompt.username && ` · ${prompt.username}`}
            </span>
            <span className="login-prompt-url">{prompt.url}</span>
            <div className="login-prompt-actions">
                {prompt.kind === 'save' ? (
                    <button type="button" disabled={busy} onClick={() => void apply('save')}>
                        Save
                    </button>
                ) : (
                    prompt.updateCandidates.map((entry) => (
                        <button
                            key={entry.uuid}
                            type="button"
                            disabled={busy}
                            onClick={() => void apply('update', entry.uuid)}
                        >
                            Update {entry.title || '(no title)'}
                        </button>
                    ))
                )}
                <button type="button" disabled={busy} onClick={() => void apply('dismiss')}>
                    Not now
                </button>
            </div>
            {error && <p className="error">{error}</p>}
        </div>
    );
}
