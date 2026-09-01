import { useState } from 'react';
import { sendToBackground } from '../../background/message-bus';
import { TotpDisplay } from '../shared/TotpDisplay';
import { QrScanner } from '../shared/QrScanner';

type Mode = 'idle' | 'scanning' | 'manual';

export function MfaSection({
    entryUuid,
    hasTotp,
    onChanged
}: {
    entryUuid: string;
    hasTotp: boolean;
    onChanged: () => void;
}) {
    const [mode, setMode] = useState<Mode>('idle');
    const [manualValue, setManualValue] = useState('');
    const [error, setError] = useState<string | undefined>(undefined);
    const [busy, setBusy] = useState(false);

    async function save(secretOrUrl: string): Promise<void> {
        setBusy(true);
        setError(undefined);
        try {
            const response = await sendToBackground({ type: 'SET_ENTRY_TOTP', entryUuid, secretOrUrl });
            if (!response.ok) {
                setError(response.error);
                return;
            }
            setMode('idle');
            setManualValue('');
            onChanged();
        } finally {
            setBusy(false);
        }
    }

    async function remove(): Promise<void> {
        if (!window.confirm('Remove the 2FA code from this entry?')) {
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            const response = await sendToBackground({ type: 'REMOVE_ENTRY_TOTP', entryUuid });
            if (!response.ok) {
                setError(response.error);
                return;
            }
            onChanged();
        } finally {
            setBusy(false);
        }
    }

    function cancelAdd(): void {
        setMode('idle');
        setManualValue('');
        setError(undefined);
    }

    return (
        <div className="detail-section">
            <label>Multi-Factor Authentication</label>
            {error && <p className="entry-row-username">{error}</p>}
            {hasTotp ? (
                <div className="mfa-active">
                    <TotpDisplay entryUuid={entryUuid} onError={setError} />
                    <button
                        type="button"
                        className="icon-button danger"
                        title="Remove 2FA code"
                        aria-label="Remove 2FA code"
                        disabled={busy}
                        onClick={() => void remove()}
                    >
                        ×
                    </button>
                </div>
            ) : mode === 'scanning' ? (
                <QrScanner onDecoded={(text) => void save(text)} onCancel={cancelAdd} />
            ) : mode === 'manual' ? (
                <div className="mfa-manual-form">
                    <input
                        type="text"
                        placeholder="Secret or otpauth:// URL"
                        value={manualValue}
                        onChange={(e) => setManualValue(e.target.value)}
                        disabled={busy}
                    />
                    <div className="mfa-manual-actions">
                        <button
                            type="button"
                            disabled={busy || !manualValue.trim()}
                            onClick={() => void save(manualValue.trim())}
                        >
                            Save
                        </button>
                        <button type="button" disabled={busy} onClick={cancelAdd}>
                            Cancel
                        </button>
                    </div>
                </div>
            ) : (
                <div className="mfa-add-actions">
                    <button type="button" onClick={() => setMode('scanning')}>
                        Scan QR Code
                    </button>
                    <button type="button" onClick={() => setMode('manual')}>
                        Add 2FA Code manually
                    </button>
                </div>
            )}
        </div>
    );
}
