import { storage } from '../platform';

// How long a revealed password/protected field stays visible before Keetar re-hides it. 0 = never re-hide.
const STORAGE_KEY = 'keetar.revealTimeoutSeconds';
export const DEFAULT_REVEAL_TIMEOUT_SECONDS = 10;

export async function getRevealTimeoutSeconds(): Promise<number> {
    const stored = await storage.get<number>(STORAGE_KEY);
    return stored !== undefined && stored >= 0 ? stored : DEFAULT_REVEAL_TIMEOUT_SECONDS;
}

export function setRevealTimeoutSeconds(seconds: number): Promise<void> {
    return storage.set(STORAGE_KEY, Math.max(0, Math.round(seconds)));
}
