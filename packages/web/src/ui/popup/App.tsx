import { useEffect, useMemo, useState } from 'react';
import { sendToBackground } from '../../background/message-bus';
import type { EntryFieldName, EntrySummary } from '../../background/vault-session';
import { getConfiguredVault } from '../../config/vault-config';

// Popup — quick access, post-unlock (§8.1). Owns credential search/selection
// and copy-to-clipboard (§8.2). No editing, no autofill, no TOTP yet — Phase
// 3's explicit scope is read-only: entry list, search, copy username/password.

type ViewState =
    | { kind: 'loading' }
    | { kind: 'no-vault' }
    | { kind: 'locked'; vaultName: string; error?: string }
    | { kind: 'unlocked'; entries: EntrySummary[] };

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
            setView({ kind: 'locked', vaultName: configured.name });
        }
    }

    async function loadEntries(): Promise<void> {
        const response = await sendToBackground({ type: 'LIST_ENTRIES' });
        if (response.ok && response.type === 'LIST_ENTRIES') {
            setView({ kind: 'unlocked', entries: response.entries });
        }
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
            setView({ kind: 'locked', vaultName: configured.name, error: response.error });
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
            return <LockedView vaultName={view.vaultName} error={view.error} onUnlock={handleUnlock} />;
        case 'unlocked':
            return <UnlockedView entries={view.entries} onLock={handleLock} />;
    }
}

function NoVaultView() {
    return (
        <div className="panel">
            <p>No vault configured yet.</p>
            <p className="hint">Select a vault file from the extension's options page first.</p>
        </div>
    );
}

function LockedView({
    vaultName,
    error,
    onUnlock
}: {
    vaultName: string;
    error: string | undefined;
    onUnlock: (password: string) => Promise<void>;
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

    return (
        <form className="panel" onSubmit={(e) => void submit(e)}>
            <p className="vault-name">{vaultName}</p>
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
    onLock
}: {
    entries: EntrySummary[];
    onLock: () => Promise<void>;
}) {
    const [search, setSearch] = useState('');
    const [copyMessage, setCopyMessage] = useState('');

    const filtered = useMemo(() => {
        const term = search.trim().toLowerCase();
        if (!term) {
            return entries;
        }
        return entries.filter(
            (entry) =>
                entry.title.toLowerCase().includes(term) || entry.username.toLowerCase().includes(term)
        );
    }, [entries, search]);

    async function copyField(entryUuid: string, field: EntryFieldName, label: string): Promise<void> {
        const response = await sendToBackground({ type: 'GET_ENTRY_FIELD', entryUuid, field });
        if (response.ok && response.type === 'GET_ENTRY_FIELD') {
            await navigator.clipboard.writeText(response.value);
            setCopyMessage(`${label} copied`);
            setTimeout(() => setCopyMessage(''), 1500);
        }
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
                <button type="button" onClick={() => void onLock()}>
                    Lock
                </button>
            </div>
            {copyMessage && <p className="copy-toast">{copyMessage}</p>}
            <ul className="entry-list">
                {filtered.map((entry) => (
                    <li key={entry.uuid} className="entry-row">
                        <div className="entry-info">
                            <div className="entry-title">{entry.title || '(no title)'}</div>
                            <div className="entry-username">{entry.username}</div>
                        </div>
                        <div className="entry-actions">
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
