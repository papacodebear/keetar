import { storage } from '../platform';

// Off by default (§ Scope) — consistent with biometric unlock also being opt-in.
const STORAGE_KEY = 'keetar.passkeyInterceptionEnabled';

export async function isPasskeyInterceptionEnabled(): Promise<boolean> {
    return (await storage.get<boolean>(STORAGE_KEY)) ?? false;
}

export function setPasskeyInterceptionEnabled(enabled: boolean): Promise<void> {
    return storage.set(STORAGE_KEY, enabled);
}
