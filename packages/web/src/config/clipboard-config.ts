import { storage } from '../platform';

// How long a copied credential stays on the clipboard before Keetar clears it. 0 = never clear.
const STORAGE_KEY = 'keetar.clipboardClearSeconds';
export const DEFAULT_CLIPBOARD_CLEAR_SECONDS = 10;

export async function getClipboardClearSeconds(): Promise<number> {
    const stored = await storage.get<number>(STORAGE_KEY);
    return stored !== undefined && stored >= 0 ? stored : DEFAULT_CLIPBOARD_CLEAR_SECONDS;
}

export function setClipboardClearSeconds(seconds: number): Promise<void> {
    return storage.set(STORAGE_KEY, Math.max(0, Math.round(seconds)));
}
