import { useEffect, useState } from 'react';
import { sendToBackground } from '../../background/message-bus';
import { scheduleClipboardClear } from '../../background/clipboard-clear';

// Live 6-8 digit code + countdown ring for an entry's TOTP secret; click the code to copy it.
export function TotpDisplay({ entryUuid, onError }: { entryUuid: string; onError?: (message: string) => void }) {
    const [code, setCode] = useState('');
    const [remainingSeconds, setRemainingSeconds] = useState(0);
    const [period, setPeriod] = useState(30);
    const [copied, setCopied] = useState(false);

    async function refresh(): Promise<void> {
        const response = await sendToBackground({ type: 'GET_ENTRY_TOTP', entryUuid });
        if (response.ok && response.type === 'GET_ENTRY_TOTP') {
            setCode(response.code);
            setRemainingSeconds(response.remainingSeconds);
            setPeriod(response.period);
        } else if (!response.ok) {
            onError?.(response.error);
        }
    }

    useEffect(() => {
        void refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entryUuid]);

    // Ticks the displayed countdown every second; re-fetches from the background (the source of
    // truth) once it reaches zero, rather than computing the next code locally.
    useEffect(() => {
        const timer = setInterval(() => {
            setRemainingSeconds((seconds) => {
                if (seconds <= 1) {
                    void refresh();
                    return 0;
                }
                return seconds - 1;
            });
        }, 1000);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entryUuid]);

    async function copyCode(): Promise<void> {
        if (!code) {
            return;
        }
        await navigator.clipboard.writeText(code);
        void scheduleClipboardClear(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
    }

    return (
        <div className="totp-display">
            <button type="button" className="totp-code-button" onClick={() => void copyCode()} title="Copy code">
                <span className="totp-code">{formatTotpCode(code)}</span>
            </button>
            <TotpRing remainingSeconds={remainingSeconds} period={period} />
            {copied && <span className="totp-copied">Copied</span>}
        </div>
    );
}

function formatTotpCode(code: string): string {
    if (code.length < 5) {
        return code;
    }
    const mid = Math.ceil(code.length / 2);
    return `${code.slice(0, mid)} ${code.slice(mid)}`;
}

function TotpRing({ remainingSeconds, period }: { remainingSeconds: number; period: number }) {
    const radius = 9;
    const circumference = 2 * Math.PI * radius;
    const fraction = period > 0 ? remainingSeconds / period : 0;
    return (
        <svg
            className={`totp-ring${remainingSeconds <= 5 ? ' urgent' : ''}`}
            width="22"
            height="22"
            viewBox="0 0 22 22"
            aria-hidden="true"
        >
            <circle cx="11" cy="11" r={radius} className="totp-ring-track" />
            <circle
                cx="11"
                cy="11"
                r={radius}
                className="totp-ring-progress"
                strokeDasharray={circumference}
                strokeDashoffset={circumference * (1 - fraction)}
                transform="rotate(-90 11 11)"
            />
        </svg>
    );
}
