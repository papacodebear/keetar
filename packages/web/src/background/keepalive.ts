import { alarms } from '../platform';

// Chrome MV3 service worker keepalive; no-op on Firefox persistent background page.
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
