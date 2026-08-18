import { storage } from '../platform';

// Auto-lock timeout: how long the vault stays unlocked while idle before it's locked automatically.
const STORAGE_KEY = 'keetar.autoLockTimeoutSeconds';
export const DEFAULT_AUTO_LOCK_TIMEOUT_SECONDS = 5 * 60;
// chrome.idle.setDetectionInterval enforces a 15s floor.
export const MIN_AUTO_LOCK_TIMEOUT_SECONDS = 15;

export async function getAutoLockTimeoutSeconds(): Promise<number> {
    const stored = await storage.get<number>(STORAGE_KEY);
    return stored && stored >= MIN_AUTO_LOCK_TIMEOUT_SECONDS ? stored : DEFAULT_AUTO_LOCK_TIMEOUT_SECONDS;
}

export function setAutoLockTimeoutSeconds(seconds: number): Promise<void> {
    return storage.set(STORAGE_KEY, Math.max(MIN_AUTO_LOCK_TIMEOUT_SECONDS, Math.round(seconds)));
}
