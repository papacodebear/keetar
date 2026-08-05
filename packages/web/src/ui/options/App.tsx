import { useEffect, useState } from 'react';
import { pickVaultFile } from '../../providers/local-file';
import { getConfiguredVault, setConfiguredVault, type ConfiguredVault } from '../../config/vault-config';
import { enroll, isBiometricEnrolled, removeEnrollment } from '../../auth/biometric';
import { isWebAuthnSupported } from '../../auth/webauthn';

// Options — setup and configuration, reachable without unlocking the vault
// (§8.1). Owns backend/provider setup and biometric enrollment (§8.2) — and
// nothing that touches decrypted vault content, ever. Biometric enrollment
// is the one place this page needs a live, but strictly scoped and
// ephemeral, unlock (§8.1) — see auth/biometric.ts's enroll(), which reads
// and verifies the vault file but never holds or displays anything from it
// beyond a yes/no "was that the right password".

export function App() {
    const [vault, setVault] = useState<ConfiguredVault | undefined>(undefined);
    const [enrolled, setEnrolled] = useState(false);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        void refresh();
    }, []);

    async function refresh(): Promise<void> {
        const configured = await getConfiguredVault();
        setVault(configured);
        setEnrolled(configured ? await isBiometricEnrolled(configured.uuid) : false);
        setLoaded(true);
    }

    async function pickFile(): Promise<void> {
        const { uuid, name } = await pickVaultFile();
        await setConfiguredVault({ uuid, name });
        await refresh();
    }

    return (
        <div>
            <h1>Keetar options</h1>

            <section>
                <h2>Vault file</h2>
                <p>{vault ? `Selected: ${vault.name}` : 'No vault file selected.'}</p>
                <button type="button" onClick={() => void pickFile()}>
                    {vault ? 'Change vault file' : 'Select vault file'}
                </button>
            </section>

            {loaded && vault && (
                <section>
                    <h2>Biometric unlock</h2>
                    <BiometricSection vault={vault} enrolled={enrolled} onChanged={refresh} />
                </section>
            )}
        </div>
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
