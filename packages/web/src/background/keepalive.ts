import { alarms, isChrome } from '../platform';

// Chrome MV3 service worker keepalive; skipped on Firefox — its persistent background page has
// no equivalent termination to prevent, and alarms.ts is real there now (see sleep-watchdog.ts).
const KEEPALIVE_ALARM = 'keepalive';
const KEEPALIVE_PERIOD_MINUTES = 0.4; // ~24s

export function startKeepalive(): void {
    if (!isChrome) {
        return;
    }
    alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
    alarms.onAlarm((alarm) => {
        if (alarm.name === KEEPALIVE_ALARM) {
            // No-op. Handling the event is what prevents SW termination.
        }
    });
}
