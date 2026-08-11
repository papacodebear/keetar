import { storage } from '../platform';

// Configured vault shared between file selection and Popup.
export type VaultBackend = 'local-file' | 'gdrive';

export interface ConfiguredVault {
    uuid: string;
    name: string;
    /** §7.3/§10 — defaults implied as 'local-file' historically; explicit now that a second backend exists. */
    provider: VaultBackend;
    /** Cloud providers only — e.g. a Google Drive file ID. Local-file's identity is entirely the uuid-keyed handle (IndexedDB, local-file.ts). */
    path?: string;
}

const STORAGE_KEY = 'keetar.configuredVault';

export function getConfiguredVault(): Promise<ConfiguredVault | undefined> {
    return storage.get<ConfiguredVault>(STORAGE_KEY);
}

export function setConfiguredVault(vault: ConfiguredVault): Promise<void> {
    return storage.set(STORAGE_KEY, vault);
}

/** "Use a different database" (Options' settings panel) — forgets which vault is configured without touching the vault file/Drive connection itself. */
export function clearConfiguredVault(): Promise<void> {
    return storage.remove(STORAGE_KEY);
}

const PENDING_OPEN_FLOW_KEY = 'keetar.pendingOpenVaultFlow';

/** Popup sets this before handing off to Options for Drive setup, so Options can skip straight to "Open Existing Database" instead of its idle screen. */
export function setPendingOpenVaultFlow(): Promise<void> {
    return storage.set(PENDING_OPEN_FLOW_KEY, true);
}

/** Options reads and clears this once on load. */
export async function consumePendingOpenVaultFlow(): Promise<boolean> {
    const pending = await storage.get<boolean>(PENDING_OPEN_FLOW_KEY);
    if (pending) {
        await storage.remove(PENDING_OPEN_FLOW_KEY);
    }
    return Boolean(pending);
}
