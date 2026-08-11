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
