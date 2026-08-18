import { ByteUtils } from '@keetar/core';
import { alarms, clipboard, sessionStorage } from '../platform';
import { getClipboardClearSeconds } from '../config/clipboard-config';
import { sendToBackground } from './message-bus';

// The plaintext itself is never sent to the background or stored — only a hash of it, so the
// clear step can confirm the clipboard still holds what Keetar copied without persisting the secret.
export async function hashText(text: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return ByteUtils.bytesToBase64(new Uint8Array(digest));
}

/** Call from a document context right after writeText() to arm the auto-clear for that value. */
export async function scheduleClipboardClear(plaintext: string): Promise<void> {
    const seconds = await getClipboardClearSeconds();
    if (seconds <= 0) {
        return;
    }
    const valueHashBase64 = await hashText(plaintext);
    await sendToBackground({ type: 'SCHEDULE_CLIPBOARD_CLEAR', valueHashBase64, delaySeconds: seconds });
}

const STORAGE_KEY = 'keetar.pendingClipboardClear';
const ALARM_NAME = 'clipboard-clear';

interface PendingClear {
    valueHashBase64: string;
    clearAt: number;
}

// Background-side: persist the pending clear and arm two independent triggers — a best-effort
// one-shot alarm at the exact time, plus a plain setTimeout for the common case where the service
// worker (kept alive by the ~24s keepalive heartbeat) is already resident. checkAndClearClipboard()
// is also piggybacked on that heartbeat as a fallback net in case both of those miss.
export async function armClipboardClear(valueHashBase64: string, delaySeconds: number): Promise<void> {
    const clearAt = Date.now() + delaySeconds * 1000;
    await sessionStorage.set(STORAGE_KEY, { valueHashBase64, clearAt } satisfies PendingClear);
    alarms.create(ALARM_NAME, { when: clearAt });
    setTimeout(() => void checkAndClearClipboard(), delaySeconds * 1000);
}

export async function checkAndClearClipboard(): Promise<void> {
    const pending = await sessionStorage.get<PendingClear>(STORAGE_KEY);
    if (!pending || Date.now() < pending.clearAt) {
        return;
    }
    await sessionStorage.remove(STORAGE_KEY);
    await clipboard.clearIfMatches(pending.valueHashBase64);
}

// No-op on Firefox (alarms.onAlarm there is a stub — its persistent background page doesn't need
// it, the setTimeout above already does the job). On Chrome this both catches the dedicated
// one-shot alarm and piggybacks on the ~24s keepalive heartbeat as a fallback net.
alarms.onAlarm((alarm) => {
    if (alarm.name === ALARM_NAME || alarm.name === 'keepalive') {
        void checkAndClearClipboard();
    }
});
