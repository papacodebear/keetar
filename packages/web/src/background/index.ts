import { installArgon2 } from './argon2-wasm';
import { vaultSession } from './vault-session';
import { registerMessageHandler, type KeetarResponse } from './message-bus';
import { startKeepalive } from './keepalive';
import { idle } from '../platform';

// Entry point — registers listeners, initialises session (§2.4).

installArgon2();
startKeepalive();

// Idle timeout (§3.4): lock on "locked" or "idle" state. 5 min default.
const DEFAULT_IDLE_TIMEOUT_SECONDS = 5 * 60;
idle.setDetectionInterval(DEFAULT_IDLE_TIMEOUT_SECONDS);
idle.onStateChanged((state) => {
    if ((state === 'idle' || state === 'locked') && vaultSession.status === 'unlocked') {
        vaultSession.lock();
    }
});

registerMessageHandler(async (request): Promise<KeetarResponse> => {
    switch (request.type) {
        case 'UNLOCK_VAULT': {
            const summary = await vaultSession.unlock(request.uuid, request.password);
            return { ok: true, type: 'UNLOCK_VAULT', summary };
        }
        case 'LOCK_VAULT':
            vaultSession.lock();
            return { ok: true, type: 'LOCK_VAULT' };
        case 'GET_STATUS':
            return { ok: true, type: 'GET_STATUS', status: vaultSession.status };
    }
});
