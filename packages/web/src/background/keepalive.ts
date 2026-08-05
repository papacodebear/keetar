import { alarms } from '../platform';

// Chrome MV3 service worker keepalive (§3.4, §9.3). Handling any alarm event
// prevents SW termination. No-op under the Firefox shim (persistent
// background page — see platform/firefox.ts).
const KEEPALIVE_ALARM = 'keepalive';
const KEEPALIVE_PERIOD_MINUTES = 0.4; // ~24s

export function startKeepalive(): void {
    alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
    alarms.onAlarm((alarm) => {
        if (alarm.name === KEEPALIVE_ALARM) {
            // No-op. Handling the event is what prevents SW termination.
        }
    });
}
