import { useEffect, useMemo, useState } from 'react';
import { ByteUtils } from '@keetar/core';
import { sendToBackground } from '../../background/message-bus';
import type { EntryFieldName, EntrySummary } from '../../background/vault-session';
import { getConfiguredVault } from '../../config/vault-config';
import type { FillCredentialsMessage } from '../../autofill/messages';
import { isBiometricEnrolled, unlockToPasswordHash } from '../../auth/biometric';
import { isWebAuthnSupported } from '../../auth/webauthn';

// Popup — quick access, post-unlock (§8.1). Owns credential search/selection,
// autofill trigger, and copy-to-clipboard (§8.2). Still no editing (that's
// Manager's job, §8.2) — this is entry list, search, copy, and now fill.
//
// Popup is also where biometric unlock actually happens (§6.2, §8.1's own
// "open extension → ... → vault open" gesture) — it's a page, so it's the
// one place (besides Options' enrollment flow) that can run the WebAuthn
// ceremony at all.

type ViewState =
    | { kind: 'loading' }
    | { kind: 'no-vault' }
    | { kind: 'locked'; vaultUuid: string; vaultName: string; biometricEnrolled: boolean; error?: string }
    | { kind: 'unlocked'; entries: EntrySummary[]; matchedUuids: Set<string> };

export function App() {
    const [view, setView] = useState<ViewState>({ kind: 'loading' });

    useEffect(() => {
        void refresh();
    }, []);

    async function refresh(): Promise<void> {
        const configured = await getConfiguredVault();
        if (!configured) {
            setView({ kind: 'no-vault' });
            return;
        }
        const status = await sendToBackground({ type: 'GET_STATUS' });
        if (status.ok && status.type === 'GET_STATUS' && status.status === 'unlocked') {
            await loadEntries();
        } else {
            const biometricEnrolled = isWebAuthnSupported() && (await isBiometricEnrolled(configured.uuid));
            setView({
                kind: 'locked',
                vaultUuid: configured.uuid,
                vaultName: configured.name,
                biometricEnrolled
            });
        }
    }

    async function loadEntries(): Promise<void> {
        const response = await sendToBackground({ type: 'LIST_ENTRIES' });
        if (response.ok && response.type === 'LIST_ENTRIES') {
            const matchedUuids = await matchActiveTab();
            setView({ kind: 'unlocked', entries: response.entries, matchedUuids });
        }
    }

    async function lockedError(vaultUuid: string, vaultName: string, error: string): Promise<void> {
        const biometricEnrolled = isWebAuthnSupported() && (await isBiometricEnrolled(vaultUuid));
        setView({ kind: 'locked', vaultUuid, vaultName, biometricEnrolled, error });
    }

    async function handleUnlock(password: string): Promise<void> {
        const configured = await getConfiguredVault();
        if (!configured) {
            setView({ kind: 'no-vault' });
            return;
        }
        const response = await sendToBackground({
            type: 'UNLOCK_VAULT',
            uuid: configured.uuid,
            password
        });
        if (response.ok) {
            await loadEntries();
        } else {
            await lockedError(configured.uuid, configured.name, response.error);
        }
    }

    async function handleBiometricUnlock(vaultUuid: string, vaultName: string): Promise<void> {
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
                await lockedError(vaultUuid, vaultName, response.error);
            }
        } catch (e) {
            await lockedError(vaultUuid, vaultName, e instanceof Error ? e.message : String(e));
        }
    }

    async function handleLock(): Promise<void> {
        await sendToBackground({ type: 'LOCK_VAULT' });
        await refresh();
    }

    switch (view.kind) {
        case 'loading':
            return <p>Loading…</p>;
        case 'no-vault':
            return <NoVaultView />;
        case 'locked':
            return (
                <LockedView
                    vaultName={view.vaultName}
                    biometricEnrolled={view.biometricEnrolled}
                    error={view.error}
                    onUnlock={handleUnlock}
                    onBiometricUnlock={() => handleBiometricUnlock(view.vaultUuid, view.vaultName)}
                />
            );
        case 'unlocked':
            return (
                <UnlockedView entries={view.entries} matchedUuids={view.matchedUuids} onLock={handleLock} />
            );
    }
}

/** Which entries match the currently active tab (§5.4) — the active tab, not this window, since Popup itself is the active tab while open. */
async function matchActiveTab(): Promise<Set<string>> {
    try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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

async function fillActiveTab(username: string | undefined, password: string | undefined): Promise<void> {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) {
        return;
    }
    const message: FillCredentialsMessage = { type: 'FILL_CREDENTIALS', username, password };
    await chrome.tabs.sendMessage(tab.id, message);
}

function NoVaultView() {
    return (
        <div className="panel">
            <p>No vault configured yet.</p>
            <p className="hint">Select a vault file from the extension's options page first.</p>
            <button type="button" onClick={() => void chrome.runtime.openOptionsPage()}>
                Open options
            </button>
        </div>
    );
}

function LockedView({
    vaultName,
    biometricEnrolled,
    error,
    onUnlock,
    onBiometricUnlock
}: {
    vaultName: string;
    biometricEnrolled: boolean;
    error: string | undefined;
    onUnlock: (password: string) => Promise<void>;
    onBiometricUnlock: () => Promise<void>;
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
            <p className="vault-name">{vaultName}</p>
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
        </form>
    );
}

function UnlockedView({
    entries,
    matchedUuids,
    onLock
}: {
    entries: EntrySummary[];
    matchedUuids: Set<string>;
    onLock: () => Promise<void>;
}) {
    const [search, setSearch] = useState('');
    const [toast, setToast] = useState('');

    const filtered = useMemo(() => {
        const term = search.trim().toLowerCase();
        const list = term
            ? entries.filter(
                  (entry) =>
                      entry.title.toLowerCase().includes(term) ||
                      entry.username.toLowerCase().includes(term)
              )
            : entries;
        // Matches for the current page first (§5.4's "N matches → open popup
        // showing match list, let user choose") — a simple sort rather than a
        // separate list, so search still works over everything.
        return [...list].sort((a, b) => {
            const aMatch = matchedUuids.has(a.uuid) ? 0 : 1;
            const bMatch = matchedUuids.has(b.uuid) ? 0 : 1;
            return aMatch - bMatch;
        });
    }, [entries, search, matchedUuids]);

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
        await fillActiveTab(username, password);
        showToast('Filled');
    }

    // Manager owns entry editing (§8.2) — Popup only opens it (§8.1).
    function openManager(): void {
        void chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') });
    }

    return (
        <div className="panel">
            <div className="toolbar">
                <input
                    type="text"
                    autoFocus
                    placeholder="Search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
                <button type="button" onClick={openManager}>
                    Manage
                </button>
                <button type="button" onClick={() => void onLock()}>
                    Lock
                </button>
            </div>
            {toast && <p className="copy-toast">{toast}</p>}
            <ul className="entry-list">
                {filtered.map((entry) => (
                    <li key={entry.uuid} className={`entry-row${matchedUuids.has(entry.uuid) ? ' matched' : ''}`}>
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
                        </div>
                    </li>
                ))}
                {filtered.length === 0 && <li className="empty">No entries found.</li>}
            </ul>
        </div>
    );
}
