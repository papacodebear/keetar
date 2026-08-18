import { useEffect, useState } from 'react';
import { generatePassword, generatePassphrase } from '@keetar/core';
import { getGeneratorPreferences, DefaultGeneratorPreferences } from '../../config/generator-config';
import { GeneratorOptionsForm, type GeneratorMode } from './GeneratorOptionsForm';
import { scheduleClipboardClear } from '../../background/clipboard-clear';

function CopyIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 24 24" role="img" aria-hidden="true">
            <rect
                x="9"
                y="9"
                width="13"
                height="13"
                rx="2"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
            />
            <path
                d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
            />
        </svg>
    );
}

// Shared by Manager (applies value to the entry) and Popup (copies via the value row's own button).
export function PasswordGeneratorPanel({
    actionLabel,
    onAction,
    onClose,
    onCopy
}: {
    actionLabel?: string;
    onAction?: (value: string) => void;
    onClose: () => void;
    onCopy?: (value: string) => void;
}) {
    const [prefsLoaded, setPrefsLoaded] = useState(false);
    const [mode, setMode] = useState<GeneratorMode>(DefaultGeneratorPreferences.mode);
    const [passwordOptions, setPasswordOptions] = useState(DefaultGeneratorPreferences.password);
    const [passphraseOptions, setPassphraseOptions] = useState(DefaultGeneratorPreferences.passphrase);
    const [regenerateNonce, setRegenerateNonce] = useState(0);
    const [value, setValue] = useState('');
    const [error, setError] = useState<string | undefined>(undefined);
    const [copied, setCopied] = useState(false);

    // Seeds session state from saved defaults; in-panel tweaks are session-only, never persisted.
    useEffect(() => {
        let cancelled = false;
        void getGeneratorPreferences().then((prefs) => {
            if (cancelled) {
                return;
            }
            setMode(prefs.mode);
            setPasswordOptions(prefs.password);
            setPassphraseOptions(prefs.passphrase);
            setPrefsLoaded(true);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!prefsLoaded) {
            return;
        }
        try {
            const next =
                mode === 'characters'
                    ? generatePassword(passwordOptions)
                    : generatePassphrase(passphraseOptions);
            setValue(next);
            setError(undefined);
        } catch (err) {
            setValue('');
            setError(err instanceof Error ? err.message : 'Failed to generate');
        }
        setCopied(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [prefsLoaded, mode, passwordOptions, passphraseOptions, regenerateNonce]);

    async function handleCopy(): Promise<void> {
        if (!value) {
            return;
        }
        await navigator.clipboard.writeText(value);
        void scheduleClipboardClear(value);
        onCopy?.(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
    }

    return (
        <div className="password-generator-panel">
            <GeneratorOptionsForm
                mode={mode}
                onModeChange={setMode}
                passwordOptions={passwordOptions}
                onPasswordOptionsChange={setPasswordOptions}
                passphraseOptions={passphraseOptions}
                onPassphraseOptionsChange={setPassphraseOptions}
            />

            <div className="password-generator-value-row">
                <input type="text" readOnly value={value} onCopy={() => onCopy?.(value)} />
                <button
                    type="button"
                    className="password-generator-copy-button"
                    disabled={!value}
                    title={copied ? 'Copied' : 'Copy'}
                    aria-label="Copy"
                    onClick={() => void handleCopy()}
                >
                    {copied ? '✓' : <CopyIcon />}
                </button>
                <button
                    type="button"
                    title="Regenerate"
                    aria-label="Regenerate"
                    onClick={() => setRegenerateNonce((n) => n + 1)}
                >
                    🎲
                </button>
            </div>
            {error && <p className="password-generator-error">{error}</p>}

            <div className="password-generator-footer">
                {actionLabel && onAction && (
                    <button
                        type="button"
                        disabled={!value}
                        onClick={() => {
                            onAction(value);
                            onClose();
                        }}
                    >
                        {actionLabel}
                    </button>
                )}
                <button type="button" onClick={onClose}>
                    Cancel
                </button>
            </div>
        </div>
    );
}
