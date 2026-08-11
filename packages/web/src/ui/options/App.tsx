import { useEffect, useState } from 'react';
import { ByteUtils } from '@keetar/core';
import { createVaultFile, pickVaultFile } from '../../providers/local-file';
import {
    clearConfiguredVault,
    getConfiguredVault,
    setConfiguredVault,
    type ConfiguredVault,
    type VaultBackend
} from '../../config/vault-config';
import { enroll, isBiometricEnrolled, removeEnrollment, unlockToPasswordHash } from '../../auth/biometric';
import { isWebAuthnSupported } from '../../auth/webauthn';
import { connectGoogleDrive, getAccessToken, GoogleDriveProvider, isGoogleDriveConnected } from '../../providers/gdrive';
import { showDrivePicker } from '../../providers/gdrive-picker';
import { checkVaultSyncStatus, resolveVaultSyncConflict } from '../../providers';
import type { SyncStatus } from '../../providers/opfs-cache';
import { createEmptyVaultBytes } from '../../providers/vault-creation';
import { sendToBackground } from '../../background/message-bus';

// Setup & config without vault unlock; owns backend setup and biometric enrollment (§8.1–8.2).

type EntryMode = 'idle' | 'open' | 'create';

// Verify Google Drive token is live before offering picker (not just cached).
async function ensureGoogleDriveAuthorized(): Promise<void> {
    try {
        await getAccessToken();
    } catch {
        await connectGoogleDrive();
    }
}

export function App() {
    const [vault, setVault] = useState<ConfiguredVault | undefined>(undefined);
    const [enrolled, setEnrolled] = useState(false);
    const [gdriveConnected, setGdriveConnected] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [mode, setMode] = useState<EntryMode>('idle');

    useEffect(() => {
        void refresh();
    }, []);

    async function refresh(): Promise<void> {
        const configured = await getConfiguredVault();
        setVault(configured);
        setEnrolled(configured ? await isBiometricEnrolled(configured.uuid) : false);
        setGdriveConnected(await isGoogleDriveConnected());
        setLoaded(true);
    }

    async function opened(): Promise<void> {
        setMode('idle');
        await refresh();
    }

    async function useDifferentVault(): Promise<void> {
        await clearConfiguredVault();
        await refresh();
    }

    if (!loaded) {
        return <p>Loading…</p>;
    }

    return (
        <div>
            <h1>Keetar</h1>

            {vault ? (
                <DatabaseSection
                    vault={vault}
                    enrolled={enrolled}
                    onChanged={refresh}
                    onDisconnect={() => void useDifferentVault()}
                />
            ) : mode === 'idle' ? (
                <div className="choice-buttons">
                    <button type="button" onClick={() => setMode('open')}>
                        Open Existing Database
                    </button>
                    <button type="button" onClick={() => setMode('create')}>
                        Create New Database
                    </button>
                </div>
            ) : mode === 'open' ? (
                <OpenVaultFlow onOpened={opened} onCancel={() => setMode('idle')} />
            ) : (
                <CreateVaultFlow
                    gdriveConnected={gdriveConnected}
                    onGdriveConnectedChange={setGdriveConnected}
                    onCreated={opened}
                    onCancel={() => setMode('idle')}
                />
            )}
        </div>
    );
}

// Vault identity + biometric enrollment; Drive connection established lazily (§8.2).
function DatabaseSection({
    vault,
    enrolled,
    onChanged,
    onDisconnect
}: {
    vault: ConfiguredVault;
    enrolled: boolean;
    onChanged: () => Promise<void>;
    onDisconnect: () => void;
}) {
    // Biometric enrollment hidden behind gear; other controls always visible.
    const [showBiometric, setShowBiometric] = useState(false);
    const [showUnlockForm, setShowUnlockForm] = useState(false);
    const [pickBusy, setPickBusy] = useState(false);
    const [pickError, setPickError] = useState<string | undefined>(undefined);
    const lockState = useVaultLockState(vault.uuid);
    const sync = useVaultSyncStatus(vault, onChanged);

    async function handleLockToggle(): Promise<void> {
        if (lockState.status === 'unlocked') {
            await lockState.lock();
            return;
        }
        setShowUnlockForm((s) => !s);
    }

    // Pick new backing file or recover missing Drive file (reconnect inline if needed).
    async function pickNewFile(): Promise<void> {
        setPickBusy(true);
        setPickError(undefined);
        try {
            if (vault.provider === 'gdrive') {
                await ensureGoogleDriveAuthorized();
                const picked = await showDrivePicker();
                if (!picked) {
                    return;
                }
                await setConfiguredVault({
                    uuid: crypto.randomUUID(),
                    name: picked.name,
                    provider: 'gdrive',
                    path: picked.fileId
                });
            } else {
                const { uuid, name } = await pickVaultFile();
                await setConfiguredVault({ uuid, name, provider: 'local-file' });
            }
            await onChanged();
        } catch (e) {
            setPickError(e instanceof Error ? e.message : String(e));
        } finally {
            setPickBusy(false);
        }
    }

    return (
        <section>
            <div className="vault-badge">
                <span className="vault-badge-text">
                    {vault.provider === 'gdrive' ? 'Google Drive' : 'Local'}:{' '}
                    <button
                        type="button"
                        className="vault-name-button"
                        title="Pick a different database file"
                        onClick={() => void pickNewFile()}
                        disabled={pickBusy}
                    >
                        {vault.name}
                    </button>
                </span>
                {vault.provider === 'gdrive' && <SyncBadge status={sync.status} />}
                <button
                    type="button"
                    className="lock-button"
                    title={lockState.status === 'unlocked' ? 'Lock database' : 'Unlock database'}
                    aria-label={lockState.status === 'unlocked' ? 'Lock database' : 'Unlock database'}
                    disabled={lockState.status === 'checking'}
                    onClick={() => void handleLockToggle()}
                >
                    {lockState.status === 'unlocked' ? '🔓' : '🔒'}
                </button>
                <button
                    type="button"
                    className="gear-button"
                    title="Biometric unlock settings"
                    aria-label="Biometric unlock settings"
                    aria-pressed={showBiometric}
                    onClick={() => setShowBiometric((s) => !s)}
                >
                    ⚙
                </button>
                <button
                    type="button"
                    className="disconnect-button"
                    title="Disconnect this database"
                    aria-label="Disconnect this database"
                    onClick={onDisconnect}
                >
                    ✕
                </button>
            </div>
            {pickError && <p className="error">{pickError}</p>}
            {vault.provider === 'gdrive' && sync.status === 'conflict' && (
                <div className="sync-conflict">
                    <p className="error">
                        This vault changed both here (while offline) and in Google Drive. Choose which copy to keep
                        — the other will be discarded.
                    </p>
                    <button type="button" onClick={() => void sync.resolve('keep-local')} disabled={sync.busy}>
                        Keep this device's copy
                    </button>{' '}
                    <button type="button" onClick={() => void sync.resolve('keep-cloud')} disabled={sync.busy}>
                        Keep Google Drive's copy
                    </button>
                    {sync.message && <p className="error">{sync.message}</p>}
                </div>
            )}
            {showUnlockForm && lockState.status === 'locked' && (
                <UnlockForm vault={vault} enrolled={enrolled} lockState={lockState} onUnlocked={() => setShowUnlockForm(false)} />
            )}
            {showBiometric && (
                <>
                    <h2>Biometric unlock</h2>
                    <BiometricSection vault={vault} enrolled={enrolled} onChanged={onChanged} />
                </>
            )}
        </section>
    );
}

type LockAttemptResult = { ok: true } | { ok: false; error: string };

// Drives shared background session lock state, synced with Popup (§8.1).
function useVaultLockState(vaultUuid: string) {
    const [status, setStatus] = useState<'checking' | 'locked' | 'unlocked'>('checking');

    useEffect(() => {
        void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vaultUuid]);

    async function refresh(): Promise<void> {
        setStatus('checking');
        const response = await sendToBackground({ type: 'GET_STATUS' });
        setStatus(response.ok && response.type === 'GET_STATUS' && response.status === 'unlocked' ? 'unlocked' : 'locked');
    }

    async function lock(): Promise<void> {
        await sendToBackground({ type: 'LOCK_VAULT' });
        await refresh();
    }

    async function unlockWithPassword(password: string): Promise<LockAttemptResult> {
        const response = await sendToBackground({ type: 'UNLOCK_VAULT', uuid: vaultUuid, password });
        if (response.ok) {
            await refresh();
            return { ok: true };
        }
        return { ok: false, error: response.error };
    }

    async function unlockWithBiometrics(): Promise<LockAttemptResult> {
        try {
            const passwordHash = await unlockToPasswordHash(vaultUuid);
            const response = await sendToBackground({
                type: 'UNLOCK_VAULT_WITH_HASH',
                uuid: vaultUuid,
                passwordHashBase64: ByteUtils.bytesToBase64(new Uint8Array(passwordHash))
            });
            if (response.ok) {
                await refresh();
                return { ok: true };
            }
            return { ok: false, error: response.error };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }

    return { status, lock, unlockWithPassword, unlockWithBiometrics };
}

function UnlockForm({
    vault,
    enrolled,
    lockState,
    onUnlocked
}: {
    vault: ConfiguredVault;
    enrolled: boolean;
    lockState: ReturnType<typeof useVaultLockState>;
    onUnlocked: () => void;
}) {
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);
    const biometricAvailable = enrolled && isWebAuthnSupported();

    async function submit(e: React.FormEvent): Promise<void> {
        e.preventDefault();
        setBusy(true);
        setError(undefined);
        const result = await lockState.unlockWithPassword(password);
        setBusy(false);
        if (result.ok) {
            setPassword('');
            onUnlocked();
        } else {
            setError(result.error);
        }
    }

    async function submitBiometric(): Promise<void> {
        setBusy(true);
        setError(undefined);
        const result = await lockState.unlockWithBiometrics();
        setBusy(false);
        if (result.ok) {
            onUnlocked();
        } else {
            setError(result.error);
        }
    }

    return (
        <form className="panel-box" onSubmit={(e) => void submit(e)}>
            {biometricAvailable && (
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
                Unlock {vault.name}
            </button>
            {error && <p className="error">{error}</p>}
        </form>
    );
}

// Sync-status badge; conflict case displays full resolution UI (§4.3).
function useVaultSyncStatus(vault: ConfiguredVault, onChanged: () => Promise<void>) {
    const applicable = vault.provider === 'gdrive';
    const [status, setStatus] = useState<SyncStatus | 'checking'>('checking');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<string | undefined>(undefined);

    useEffect(() => {
        if (!applicable) {
            return;
        }
        void check();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vault.uuid, applicable]);

    async function check(): Promise<void> {
        setStatus('checking');
        try {
            setStatus(await checkVaultSyncStatus(vault));
        } catch (e) {
            setMessage(e instanceof Error ? e.message : String(e));
            setStatus('ok');
        }
    }

    // Unsynced local + changed cloud copy: user must choose which to keep (§4.3).
    async function resolve(resolution: 'keep-local' | 'keep-cloud'): Promise<void> {
        setBusy(true);
        setMessage(undefined);
        try {
            await resolveVaultSyncConflict(vault, resolution);
            await check();
            await onChanged();
        } catch (e) {
            setMessage(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    return { status, busy, message, resolve };
}

function SyncBadge({ status }: { status: SyncStatus | 'checking' }) {
    if (status === 'checking') {
        return null;
    }
    if (status === 'conflict') {
        return (
            <span className="sync-badge sync-conflict-badge" title="Sync conflict — resolve below">
                ⚠
            </span>
        );
    }
    if (status === 'cloud-newer') {
        return (
            <span className="sync-badge sync-pending-badge" title="A newer copy is waiting in Google Drive — the next unlock will fetch it">
                ↓
            </span>
        );
    }
    return (
        <span className="sync-badge sync-ok-badge" title="Synced">
            ✓
        </span>
    );
}

// Both local and Drive files as existing sources; Drive connects inline (§8.1).
function OpenVaultFlow({ onOpened, onCancel }: { onOpened: () => Promise<void>; onCancel: () => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);

    async function openLocal(): Promise<void> {
        setBusy(true);
        setError(undefined);
        try {
            const { uuid, name } = await pickVaultFile();
            await setConfiguredVault({ uuid, name, provider: 'local-file' });
            await onOpened();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    async function openFromDrive(): Promise<void> {
        setBusy(true);
        setError(undefined);
        try {
            await ensureGoogleDriveAuthorized();
            const picked = await showDrivePicker();
            if (!picked) {
                return;
            }
            await setConfiguredVault({
                uuid: crypto.randomUUID(),
                name: picked.name,
                provider: 'gdrive',
                path: picked.fileId
            });
            await onOpened();
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="panel-box">
            <p className="hint">Where is the database file?</p>
            <button type="button" onClick={() => void openLocal()} disabled={busy}>
                This computer
            </button>{' '}
            <button type="button" onClick={() => void openFromDrive()} disabled={busy}>
                Google Drive
            </button>{' '}
            <button type="button" onClick={onCancel} disabled={busy}>
                Cancel
            </button>
            {error && <p className="error">{error}</p>}
        </div>
    );
}

function CreateVaultFlow({
    gdriveConnected,
    onGdriveConnectedChange,
    onCreated,
    onCancel
}: {
    gdriveConnected: boolean;
    onGdriveConnectedChange: (connected: boolean) => void;
    onCreated: () => Promise<void>;
    onCancel: () => void;
}) {
    return (
        <div className="panel-box">
            <CreateVaultSection
                gdriveConnected={gdriveConnected}
                onGdriveConnectedChange={onGdriveConnectedChange}
                onChanged={onCreated}
            />
            <button type="button" onClick={onCancel}>
                Cancel
            </button>
        </div>
    );
}

function CreateVaultSection({
    gdriveConnected,
    onGdriveConnectedChange,
    onChanged
}: {
    gdriveConnected: boolean;
    onGdriveConnectedChange: (connected: boolean) => void;
    onChanged: () => Promise<void>;
}) {
    const [name, setName] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [backend, setBackend] = useState<VaultBackend>('local-file');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ text: string; kind: 'error' | 'success' } | undefined>(undefined);

    async function create(e: React.FormEvent): Promise<void> {
        e.preventDefault();
        if (password !== confirmPassword) {
            setMessage({ text: 'Passwords do not match.', kind: 'error' });
            return;
        }
        setBusy(true);
        setMessage(undefined);
        try {
            const data = await createEmptyVaultBytes(name, password);
            if (backend === 'gdrive') {
                await ensureGoogleDriveAuthorized();
                onGdriveConnectedChange(true);
                const { fileId } = await new GoogleDriveProvider().createFile(name, data);
                await setConfiguredVault({ uuid: crypto.randomUUID(), name, provider: 'gdrive', path: fileId });
            } else {
                const created = await createVaultFile(name, data);
                await setConfiguredVault({ uuid: created.uuid, name: created.name, provider: 'local-file' });
            }
            setName('');
            setPassword('');
            setConfirmPassword('');
            setMessage({ text: 'Vault created.', kind: 'success' });
            await onChanged();
        } catch (e) {
            setMessage({ text: e instanceof Error ? e.message : String(e), kind: 'error' });
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={(e) => void create(e)}>
            <div className="field">
                <input
                    type="text"
                    placeholder="Vault name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    disabled={busy}
                />
            </div>
            <div className="field">
                <input
                    type="password"
                    autoComplete="new-password"
                    placeholder="Master password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={busy}
                />
            </div>
            <div className="field">
                <input
                    type="password"
                    autoComplete="new-password"
                    placeholder="Confirm master password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    disabled={busy}
                />
            </div>
            <label>
                <input
                    type="radio"
                    checked={backend === 'local-file'}
                    onChange={() => setBackend('local-file')}
                    disabled={busy}
                />{' '}
                Local file
            </label>{' '}
            <label>
                <input
                    type="radio"
                    checked={backend === 'gdrive'}
                    onChange={() => setBackend('gdrive')}
                    disabled={busy}
                />{' '}
                Google Drive{!gdriveConnected && ' (connects on create)'}
            </label>
            <div>
                <button type="submit" disabled={busy || !name || !password}>
                    Create vault
                </button>
            </div>
            {message && <p className={message.kind}>{message.text}</p>}
        </form>
    );
}

function BiometricSection({
    vault,
    enrolled,
    onChanged
}: {
    vault: ConfiguredVault;
    enrolled: boolean;
    onChanged: () => Promise<void>;
}) {
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ text: string; kind: 'error' | 'success' } | undefined>(undefined);

    if (!isWebAuthnSupported()) {
        return <p className="hint">This browser doesn't support WebAuthn — biometric unlock isn't available.</p>;
    }

    if (enrolled) {
        return (
            <div>
                <p className="success">Biometric unlock is enrolled for this vault.</p>
                <button type="button" onClick={() => void remove()} disabled={busy}>
                    Remove biometric unlock
                </button>
            </div>
        );
    }

    async function enrollNow(e: React.FormEvent): Promise<void> {
        e.preventDefault();
        setBusy(true);
        setMessage(undefined);
        try {
            await enroll(vault.uuid, password);
            setPassword('');
            setMessage({ text: 'Biometric unlock enrolled.', kind: 'success' });
            await onChanged();
        } catch (e) {
            setMessage({ text: e instanceof Error ? e.message : String(e), kind: 'error' });
        } finally {
            setBusy(false);
        }
    }

    async function remove(): Promise<void> {
        setBusy(true);
        try {
            await removeEnrollment(vault.uuid);
            await onChanged();
        } finally {
            setBusy(false);
        }
    }

    return (
        <form onSubmit={(e) => void enrollNow(e)}>
            <p className="hint">
                Enter the master password once to enroll Touch ID, Windows Hello, or a FIDO2 hardware key for
                quick unlock.
            </p>
            <div className="field">
                <input
                    type="password"
                    autoComplete="off"
                    placeholder="Master password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={busy}
                />
            </div>
            <button type="submit" disabled={busy || !password}>
                Enroll
            </button>
            {message && <p className={message.kind}>{message.text}</p>}
        </form>
    );
}
