import { alarms, sessionStorage } from '../platform';

// Detects system sleep via wall-clock gaps between checkpoints, since chrome.idle's own
// idle-time tracking gets reset by the very input used to wake the machine (§ chat).
const WATCHDOG_ALARM = 'sleep-watchdog';
const CHECK_PERIOD_MINUTES = 0.5;
const GAP_THRESHOLD_MS = CHECK_PERIOD_MINUTES * 60_000 * 3;
const LAST_CHECK_KEY = 'keetar.sleepWatchdogLastCheck';

export function startSleepWatchdog(onSleepDetected: () => void): void {
    alarms.create(WATCHDOG_ALARM, { periodInMinutes: CHECK_PERIOD_MINUTES });
    alarms.onAlarm((alarm) => {
        if (alarm.name === WATCHDOG_ALARM) {
            void checkForGap(onSleepDetected);
        }
    });
    void checkForGap(onSleepDetected);
}

async function checkForGap(onSleepDetected: () => void): Promise<void> {
    const now = Date.now();
    const lastCheck = await sessionStorage.get<number>(LAST_CHECK_KEY);
    await sessionStorage.set(LAST_CHECK_KEY, now);
    if (lastCheck !== undefined && now - lastCheck > GAP_THRESHOLD_MS) {
        onSleepDetected();
    }
}
