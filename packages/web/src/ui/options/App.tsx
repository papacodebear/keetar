import { useEffect, useRef, useState } from 'react';
import { ByteUtils } from '@keetar/core';
import { createVaultFile, ensureVaultFilePermission, pickVaultFile, relinkVaultFile } from '../../providers/local-file';
import {
    checkNativeHostStatus,
    createNativeVaultFile,
    ensureNativeHostPermission,
    HOST_INSTALL_URL,
    hostDownloadFor,
    pickNativeVaultFile,
    type NativeHostStatus
} from '../../providers/native-file';
import { isChrome } from '../../platform';
import { openManagerTab } from '../shared/open-manager';
import { closeCurrentTab, consumeBiometricUnlockRequest } from '../shared/biometric-unlock-tab';
import { ErrorBox } from '../shared/ErrorBox';
import {
    clearConfiguredVault,
    getConfiguredVault,
    setConfiguredVault,
    type ConfiguredVault,
    type VaultBackend
} from '../../config/vault-config';
import {
    enroll,
    isBiometricEnrolled,
    prefetchForBiometricEnroll,
    removeEnrollment,
    unlockToPasswordHash
} from '../../auth/biometric';
import { isWebAuthnSupported } from '../../auth/webauthn';
import { connectGoogleDrive, ensureGoogleDriveAuthorized, GoogleDriveProvider, isGoogleDriveConnected } from '../../providers/gdrive';
import { showDrivePicker } from '../../providers/gdrive-picker';
import { checkVaultSyncStatus, resolveVaultSyncConflict } from '../../providers';
import type { SyncStatus } from '../../providers/opfs-cache';
import { createEmptyVaultBytes } from '../../providers/vault-creation';
import { onVaultLocked, sendToBackground } from '../../background/message-bus';
import { VaultProviderIcon } from '../shared/VaultProviderIcon';
import { GeneratorOptionsForm, type GeneratorMode } from '../shared/GeneratorOptionsForm';
import { getGeneratorPreferences, setGeneratorPreferences } from '../../config/generator-config';
import type { GeneratorPreferences } from '../../config/generator-config';
import { isPasskeyInterceptionEnabled, setPasskeyInterceptionEnabled } from '../../config/passkey-config';
import { getAutoLockTimeoutSeconds, MIN_AUTO_LOCK_TIMEOUT_SECONDS } from '../../config/security-config';
import { getClipboardClearSeconds, setClipboardClearSeconds } from '../../config/clipboard-config';
import { getRevealTimeoutSeconds, setRevealTimeoutSeconds } from '../../config/reveal-config';
import { listTrustedHosts, revokeHost, type TrustedHost } from '../../config/trusted-hosts';

// Setup & config without vault unlock; owns backend setup and biometric enrollment (§8.1–8.2).

type EntryMode = 'idle' | 'open' | 'create';

const SECTIONS = [
    { id: 'database', label: 'Database' },
    { id: 'local-files', label: 'Local files' },
    { id: 'biometric', label: 'Biometric unlock' },
    { id: 'passkeys', label: 'Passkeys' },
    { id: 'security', label: 'Security' },
    { id: 'generator', label: 'Password generator' },
    { id: 'trusted-sites', label: 'Trusted sites' }
].filter(({ id }) => !isChrome || id !== 'local-files');

const HOST_CHECK_INTERVAL_MS = 3000;

function isFilePickerCancellation(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
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
        await sendToBackground({ type: 'LOCK_VAULT' });
        await clearConfiguredVault();
        await refresh();
    }

    if (!loaded) {
        return <p>Loading…</p>;
    }

    return (
        <div>
            <h1>Keetar</h1>
            <div className="options-layout">
                <SectionNav />
                <div className="options-content">
                    <section id="database">
                        <h2>Database</h2>
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
                    </section>

                    {!isChrome && (
                        <section id="local-files">
                            <h2>Local files</h2>
                            <NativeHostSection />
                        </section>
                    )}

                    <section id="biometric">
                        <h2>Biometric unlock</h2>
                        <BiometricUnlockSection vault={vault} enrolled={enrolled} onChanged={refresh} />
                    </section>

                    <section id="passkeys">
                        <h2>Passkeys</h2>
                        <PasskeySection />
                    </section>

                    <section id="security">
                        <SecuritySection />
                    </section>

                    <section id="generator">
                        <GeneratorPreferencesSection />
                    </section>

                    <section id="trusted-sites">
                        <TrustedHostsSection />
                    </section>
                </div>
            </div>
        </div>
    );
}

// Threshold-based rather than IntersectionObserver: a section near the end of a short page may
// never have room to scroll into a fixed "top zone", which left the previous item stuck active.
const ACTIVE_SECTION_THRESHOLD_PX = 96;

function computeActiveSection(): string {
    const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
    if (atBottom) {
        return SECTIONS[SECTIONS.length - 1].id;
    }
    let current: string = SECTIONS[0].id;
    for (const { id } of SECTIONS) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= ACTIVE_SECTION_THRESHOLD_PX) {
            current = id;
        }
    }
    return current;
}

// Highlights the section nearest the top of the viewport as the user scrolls (§ Options nav redesign).
function SectionNav() {
    const [active, setActive] = useState<string>(SECTIONS[0].id);

    useEffect(() => {
        function onScroll(): void {
            setActive(computeActiveSection());
        }
        onScroll();
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll);
        return () => {
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onScroll);
        };
    }, []);

    return (
        <nav className="options-nav">
            {SECTIONS.map(({ id, label }) => (
                <a
                    key={id}
                    href={`#${id}`}
                    className={id === active ? 'active' : undefined}
                    onClick={() => setActive(id)}
                >
                    {label}
                </a>
            ))}
        </nav>
    );
}

// Auto-lock timeout, clipboard auto-clear, and reveal auto-hide — global preferences, independent of any vault.
function SecuritySection() {
    const [autoLockMinutes, setAutoLockMinutes] = useState<number | undefined>(undefined);
    const [clipboardClearSeconds, setClipboardClearSecondsState] = useState<number | undefined>(undefined);
    const [revealTimeoutSeconds, setRevealTimeoutSecondsState] = useState<number | undefined>(undefined);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        void getAutoLockTimeoutSeconds().then((seconds) => setAutoLockMinutes(seconds / 60));
        void getClipboardClearSeconds().then(setClipboardClearSecondsState);
        void getRevealTimeoutSeconds().then(setRevealTimeoutSecondsState);
    }, []);

    async function handleSave(): Promise<void> {
        if (autoLockMinutes === undefined || clipboardClearSeconds === undefined || revealTimeoutSeconds === undefined) {
            return;
        }
        const seconds = Math.max(MIN_AUTO_LOCK_TIMEOUT_SECONDS, Math.round(autoLockMinutes * 60));
        await sendToBackground({ type: 'SET_AUTO_LOCK_TIMEOUT', seconds });
        await setClipboardClearSeconds(clipboardClearSeconds);
        await setRevealTimeoutSeconds(revealTimeoutSeconds);
        setAutoLockMinutes(seconds / 60);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
    }

    if (autoLockMinutes === undefined || clipboardClearSeconds === undefined || revealTimeoutSeconds === undefined) {
        return null;
    }

    return (
        <>
            <h2>Security</h2>
            <div className="field-inline">
                <label>
                    Lock the vault after being idle for
                    <input
                        type="number"
                        min={MIN_AUTO_LOCK_TIMEOUT_SECONDS / 60}
                        step="1"
                        value={autoLockMinutes}
                        onChange={(e) => setAutoLockMinutes(Number(e.target.value))}
                    />
                    minutes
                </label>
            </div>
            <div className="field-inline">
                <label>
                    Clear the clipboard
                    <input
                        type="number"
                        min={0}
                        step="1"
                        value={clipboardClearSeconds}
                        onChange={(e) => setClipboardClearSecondsState(Number(e.target.value))}
                    />
                    seconds after copying a password or code (0 = never)
                </label>
            </div>
            <div className="field-inline">
                <label>
                    Re-hide a revealed password or protected field after
                    <input
                        type="number"
                        min={0}
                        step="1"
                        value={revealTimeoutSeconds}
                        onChange={(e) => setRevealTimeoutSecondsState(Number(e.target.value))}
                    />
                    seconds (0 = never)
                </label>
            </div>
            <button type="button" onClick={() => void handleSave()}>
                Save
            </button>
            {saved && <span className="success">Saved</span>}
        </>
    );
}

// Hosts trusted to receive autofilled credentials (§ Options item 9) — trusted once from the
// popup/content-script prompt, revocable here.
function TrustedHostsSection() {
    const [hosts, setHosts] = useState<TrustedHost[] | undefined>(undefined);
    const [expanded, setExpanded] = useState(false);

    async function refresh(): Promise<void> {
        setHosts(await listTrustedHosts());
    }

    useEffect(() => {
        void refresh();
    }, []);

    async function revoke(domain: string): Promise<void> {
        await revokeHost(domain);
        await refresh();
    }

    if (!hosts) {
        return null;
    }

    return (
        <>
            <h2>Trusted sites</h2>
            <p className="hint">Sites Keetar is allowed to autofill credentials into. Revoke to require confirmation again.</p>
            {hosts.length === 0 ? (
                <p className="hint">No sites trusted yet.</p>
            ) : (
                <>
                    <button type="button" className="trusted-hosts-toggle" onClick={() => setExpanded((v) => !v)}>
                        {expanded ? 'Hide' : `Show ${hosts.length} trusted site${hosts.length === 1 ? '' : 's'}`}
                    </button>
                    {expanded && (
                        <ul className="trusted-hosts-list">
                            {hosts.map((host) => (
                                <li key={host.domain}>
                                    <span>{host.domain}</span>
                                    <button type="button" onClick={() => void revoke(host.domain)}>
                                        Revoke
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            )}
        </>
    );
}

// Saved generator defaults — global preference, independent of any vault (§8.2).
function GeneratorPreferencesSection() {
    const [preferences, setPreferences] = useState<GeneratorPreferences | undefined>(undefined);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        void getGeneratorPreferences().then(setPreferences);
    }, []);

    async function handleSave(): Promise<void> {
        if (!preferences) {
            return;
        }
        await setGeneratorPreferences(preferences);
        setSaved(true);
        setTimeout(() => setSaved(false), 1500);
    }

    if (!preferences) {
        return null;
    }

    return (
        <>
            <h2>Password Generator</h2>
            <p className="hint">Defaults used each time the password generator opens in Manager or the popup.</p>
            <GeneratorOptionsForm
                mode={preferences.mode}
                onModeChange={(mode: GeneratorMode) => setPreferences({ ...preferences, mode })}
                passwordOptions={preferences.password}
                onPasswordOptionsChange={(password) => setPreferences({ ...preferences, password })}
                passphraseOptions={preferences.passphrase}
                onPassphraseOptionsChange={(passphrase) => setPreferences({ ...preferences, passphrase })}
            />
            <button type="button" onClick={() => void handleSave()}>
                Save
            </button>
            {saved && <span className="success">Saved</span>}
        </>
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
    const [pickBusy, setPickBusy] = useState(false);
    const [pickError, setPickError] = useState<string | undefined>(undefined);
    const lockState = useVaultLockState(vault);
    const sync = useVaultSyncStatus(vault, onChanged);

    // Form visibility follows lock status directly — no extra click to reveal it.
    async function handleLockClick(): Promise<void> {
        if (lockState.status === 'unlocked') {
            await lockState.lock();
        }
    }

    function openManager(): void {
        void openManagerTab();
    }

    // Unlocking here means the user is already looking at this tab for it — navigate straight
    // there instead of opening/focusing a separate Manager tab and leaving this one behind.
    function goToManager(): void {
        window.location.replace(chrome.runtime.getURL('manager/manager.html'));
    }

    // Pick new backing file or recover missing Drive file (reconnect inline if needed).
    async function pickNewFile(): Promise<void> {
        setPickBusy(true);
        setPickError(undefined);
        try {
            if (vault.provider === 'gdrive') {
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
            } else if (vault.provider === 'native-file') {
                await ensureNativeHostPermission();
                const picked = await pickNativeVaultFile();
                if (!picked) {
                    return;
                }
                await setConfiguredVault({ ...vault, name: picked.name, path: picked.path });
            } else {
                // Re-link the same vault identity to a new handle — a new uuid here would silently
                // orphan biometric enrollment (and anything else keyed by this vault's uuid).
                const { name } = await relinkVaultFile(vault.uuid);
                await setConfiguredVault({ ...vault, name });
            }
            await onChanged();
        } catch (e) {
            if (!isFilePickerCancellation(e)) {
                setPickError(e instanceof Error ? e.message : String(e));
            }
        } finally {
            setPickBusy(false);
        }
    }

    return (
        <>
            <div className="vault-badge">
                <VaultProviderIcon provider={vault.provider} />
                <span className="vault-badge-text">
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
                {lockState.status === 'unlocked' && (
                    <button
                        type="button"
                        className="manager-button"
                        title="View all entries & groups"
                        aria-label="View all entries & groups"
                        onClick={openManager}
                    >
                        ☰
                    </button>
                )}
                <button
                    type="button"
                    className="lock-button"
                    title={lockState.status === 'unlocked' ? 'Lock database' : 'Unlock database'}
                    aria-label={lockState.status === 'unlocked' ? 'Lock database' : 'Unlock database'}
                    disabled={lockState.status === 'checking'}
                    onClick={() => void handleLockClick()}
                >
                    {lockState.status === 'unlocked' ? '🔓' : '🔒'}
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
            {pickError && <ErrorBox message={pickError} />}
            {vault.provider === 'gdrive' && sync.status === 'conflict' && (
                <div className="sync-conflict">
                    <p className="hint">
                        This vault changed both here (while offline) and in Google Drive. Choose which copy to keep
                        — the other will be discarded.
                    </p>
                    <button type="button" onClick={() => void sync.resolve('keep-local')} disabled={sync.busy}>
                        Keep this device's copy
                    </button>{' '}
                    <button type="button" onClick={() => void sync.resolve('keep-cloud')} disabled={sync.busy}>
                        Keep Google Drive's copy
                    </button>
                    {sync.message && <ErrorBox message={sync.message} />}
                </div>
            )}
            {vault.provider === 'gdrive' && sync.status === 'unsynced' && (
                <div className="sync-conflict">
                    <p className="hint">Changes made here haven't reached Google Drive yet. This is usually a stale sign-in.</p>
                    <button type="button" onClick={() => void sync.reconnect()} disabled={sync.busy}>
                        {sync.busy ? 'Reconnecting…' : 'Reconnect Google Drive'}
                    </button>
                    {sync.message && <ErrorBox message={sync.message} />}
                </div>
            )}
            {lockState.status === 'locked' && (
                <UnlockForm vault={vault} enrolled={enrolled} lockState={lockState} onUnlocked={goToManager} />
            )}
        </>
    );
}

// Wraps BiometricSection with the "no vault yet" grayed-out state (§ Options nav redesign).
function BiometricUnlockSection({
    vault,
    enrolled,
    onChanged
}: {
    vault: ConfiguredVault | undefined;
    enrolled: boolean;
    onChanged: () => Promise<void>;
}) {
    if (!isWebAuthnSupported()) {
        return <p className="hint">This browser doesn't support WebAuthn — biometric unlock isn't available.</p>;
    }
    if (!vault) {
        return (
            <div className="section-disabled">
                <p className="hint">Enroll Touch ID, Windows Hello, or a FIDO2 hardware key for quick unlock.</p>
                <button type="button" disabled>
                    Set up biometric unlock
                </button>
                <p className="hint">Select a database above first.</p>
            </div>
        );
    }
    return <BiometricSection vault={vault} enrolled={enrolled} onChanged={onChanged} />;
}

// Firefox needs the helper for local databases; it's rechecked while missing so installing it updates this live.
function NativeHostSection() {
    const [status, setStatus] = useState<NativeHostStatus | undefined>(undefined);
    const download = hostDownloadFor(navigator.platform);

    useEffect(() => {
        void checkNativeHostStatus().then(setStatus);
    }, []);

    useEffect(() => {
        if (status?.kind !== 'missing') {
            return;
        }
        const timer = setInterval(() => void checkNativeHostStatus().then(setStatus), HOST_CHECK_INTERVAL_MS);
        return () => clearInterval(timer);
    }, [status?.kind]);

    async function allow(): Promise<void> {
        try {
            await ensureNativeHostPermission();
            setStatus(await checkNativeHostStatus());
        } catch (e) {
            setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
        }
    }

    if (!status) {
        return <p className="hint">Checking for the helper app…</p>;
    }
    if (status.kind === 'connected') {
        return <p className="success">Helper app connected (version {status.version}).</p>;
    }
    if (status.kind === 'needs-permission') {
        return (
            <>
                <p className="hint">Firefox needs the Keetar helper app to open and save databases on this computer.</p>
                <button type="button" onClick={() => void allow()}>
                    Allow Keetar to use the helper app
                </button>
            </>
        );
    }
    return (
        <>
            {status.kind === 'error' ? (
                <ErrorBox message={status.message} />
            ) : (
                <p className="hint">The helper app isn't installed yet. This page will update once it is.</p>
            )}
            {download && (
                <p>
                    <a href={download.url}>Download the helper app for {download.label}</a>
                    <br />
                    <span className="hint">{download.instructions}</span>
                </p>
            )}
            <a href={HOST_INSTALL_URL} target="_blank" rel="noreferrer">
                Full install steps
            </a>{' '}
            <button type="button" onClick={() => void checkNativeHostStatus().then(setStatus)}>
                Check again
            </button>
        </>
    );
}

function PasskeySection() {
    const [enabled, setEnabled] = useState<boolean | undefined>(undefined);

    useEffect(() => {
        void isPasskeyInterceptionEnabled().then(setEnabled);
    }, []);

    async function toggle(next: boolean): Promise<void> {
        setEnabled(next);
        await setPasskeyInterceptionEnabled(next);
    }

    if (enabled === undefined) {
        return null;
    }

    return (
        <div>
            <label>
                <input type="checkbox" checked={enabled} onChange={(e) => void toggle(e.target.checked)} /> Let Keetar
                offer to create and sign in with passkeys on websites
            </label>
            <p className="hint">Reload any open tabs after changing this for it to take effect.</p>
        </div>
    );
}

type LockAttemptResult = { ok: true } | { ok: false; error: string };

// Drives shared background session lock state, synced with Popup (§8.1).
function useVaultLockState(vault: ConfiguredVault) {
    const [status, setStatus] = useState<'checking' | 'locked' | 'unlocked'>('checking');

    useEffect(() => {
        void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vault.uuid]);

    // Shows the unlock form the instant a background-triggered lock (e.g. idle timeout) happens,
    // rather than only on this page's next own status check.
    useEffect(() => {
        onVaultLocked(() => setStatus('locked'));
    }, []);

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
        try {
            if (vault.provider === 'local-file') {
                await ensureVaultFilePermission(vault.uuid);
            }
            const response = await sendToBackground({ type: 'UNLOCK_VAULT', uuid: vault.uuid, password });
            if (response.ok) {
                await refresh();
                return { ok: true };
            }
            return { ok: false, error: response.error };
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
    }

    async function unlockWithBiometrics(): Promise<LockAttemptResult> {
        try {
            if (vault.provider === 'local-file') {
                await ensureVaultFilePermission(vault.uuid);
            }
            const passwordHash = await unlockToPasswordHash(vault.uuid);
            const response = await sendToBackground({
                type: 'UNLOCK_VAULT_WITH_HASH',
                uuid: vault.uuid,
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
    const startedFromPopup = useRef(false);

    useEffect(() => {
        if (consumeBiometricUnlockRequest() && biometricAvailable) {
            startedFromPopup.current = true;
            void submitBiometric();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
            // Returns to the page the popup was opened on, which redetects its login fields.
            if (startedFromPopup.current) {
                closeCurrentTab();
            } else {
                onUnlocked();
            }
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
            {error && <ErrorBox message={error} />}
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
            // Was: setStatus('ok') — hid the failure behind a green checkmark, since sync.message
            // below only ever rendered under the 'conflict' branch. 'unsynced' surfaces it instead.
            setMessage(e instanceof Error ? e.message : String(e));
            setStatus('unsynced');
        }
    }

    // Interactive OAuth — recovers a Drive session the silent reauth in write()/read() already
    // gave up on.
    async function reconnect(): Promise<void> {
        setBusy(true);
        setMessage(undefined);
        try {
            await connectGoogleDrive();
            await check();
        } catch (e) {
            setMessage(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
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

    return { status, busy, message, resolve, reconnect };
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
    if (status === 'unsynced') {
        return (
            <span className="sync-badge sync-pending-badge" title="Local changes haven't reached Google Drive yet — open the vault and try Force Resync or Reconnect Google Drive">
                ↑
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
function OpenVaultFlow({
    onOpened,
    onCancel
}: {
    onOpened: () => Promise<void>;
    onCancel: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);

    async function openLocal(): Promise<void> {
        setBusy(true);
        setError(undefined);
        try {
            if (isChrome) {
                const { uuid, name } = await pickVaultFile();
                await setConfiguredVault({ uuid, name, provider: 'local-file' });
            } else {
                await ensureNativeHostPermission();
                const picked = await pickNativeVaultFile();
                if (!picked) {
                    return;
                }
                await setConfiguredVault({ uuid: crypto.randomUUID(), ...picked, provider: 'native-file' });
            }
            await onOpened();
        } catch (e) {
            if (!isFilePickerCancellation(e)) {
                setError(e instanceof Error ? e.message : String(e));
            }
        } finally {
            setBusy(false);
        }
    }

    async function openFromDrive(): Promise<void> {
        setBusy(true);
        setError(undefined);
        try {
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
            {error && <ErrorBox message={error} />}
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
            if (backend === 'local-file' && !isChrome) {
                await ensureNativeHostPermission();
            }
            const data = await createEmptyVaultBytes(name, password);
            if (backend === 'gdrive') {
                await ensureGoogleDriveAuthorized();
                onGdriveConnectedChange(true);
                const { fileId } = await new GoogleDriveProvider().createFile(name, data);
                await setConfiguredVault({ uuid: crypto.randomUUID(), name, provider: 'gdrive', path: fileId });
            } else if (isChrome) {
                const created = await createVaultFile(name, data);
                await setConfiguredVault({ uuid: created.uuid, name: created.name, provider: 'local-file' });
            } else {
                const created = await createNativeVaultFile(name, data);
                if (!created) {
                    return;
                }
                await setConfiguredVault({ uuid: crypto.randomUUID(), ...created, provider: 'native-file' });
            }
            setName('');
            setPassword('');
            setConfirmPassword('');
            setMessage({ text: 'Vault created.', kind: 'success' });
            await onChanged();
        } catch (e) {
            if (!isFilePickerCancellation(e)) {
                setMessage({ text: e instanceof Error ? e.message : String(e), kind: 'error' });
            }
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
            {message &&
                (message.kind === 'error' ? <ErrorBox message={message.text} /> : <p className="success">{message.text}</p>)}
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
    const [enrolling, setEnrolling] = useState(false);
    const [requireVerification, setRequireVerification] = useState(true);

    // Starts the Drive round trip the moment this section is on the page, not on click — by
    // enroll time the bytes are usually already there, so the WebAuthn call keeps a fresh gesture.
    useEffect(() => {
        if (!enrolled) {
            prefetchForBiometricEnroll(vault);
        }
    }, [vault, enrolled]);

    if (enrolled) {
        return (
            <div>
                <p className="success">Biometric auth enabled.</p>
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
            await enroll(vault, password, requireVerification ? 'required' : 'discouraged');
            setPassword('');
            setEnrolling(false);
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

    function cancelEnrolling(): void {
        setEnrolling(false);
        setPassword('');
        setMessage(undefined);
    }

    // Password field stays hidden until asked for, so it can't be mistaken for the unlock form above.
    if (!enrolling) {
        return (
            <div>
                <p className="hint">Enroll Touch ID, Windows Hello, or a FIDO2 hardware key for quick unlock.</p>
                <button type="button" onClick={() => setEnrolling(true)}>
                    Set up biometric unlock
                </button>
            </div>
        );
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
                    autoFocus
                    autoComplete="off"
                    placeholder="Keepass DB Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={busy}
                />
            </div>
            <label>
                <input
                    type="checkbox"
                    checked={requireVerification}
                    onChange={(e) => setRequireVerification(e.target.checked)}
                    disabled={busy}
                />{' '}
                Require a PIN or biometric at each unlock (recommended)
            </label>
            {!requireVerification && (
                <p className="hint">
                    Anyone with this browser profile and your security key could unlock the vault with a touch. To
                    change this later, remove biometric unlock and enroll again.
                </p>
            )}
            <button type="submit" disabled={busy || !password}>
                Enroll
            </button>{' '}
            <button type="button" onClick={cancelEnrolling} disabled={busy}>
                Cancel
            </button>
            {message &&
                (message.kind === 'error' ? <ErrorBox message={message.text} /> : <p className="success">{message.text}</p>)}
        </form>
    );
}
