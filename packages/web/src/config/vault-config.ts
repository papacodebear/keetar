import { storage } from '../platform';

// Which vault is configured — shared between whatever currently owns file
// selection (temporarily src/dev-harness/, eventually Options per §8.2) and
// Popup (which needs the uuid to send with UNLOCK_VAULT). A single module so
// the storage key and shape only exist in one place.

export interface ConfiguredVault {
    uuid: string;
    name: string;
}

const STORAGE_KEY = 'keetar.configuredVault';

export function getConfiguredVault(): Promise<ConfiguredVault | undefined> {
    return storage.get<ConfiguredVault>(STORAGE_KEY);
}

export function setConfiguredVault(vault: ConfiguredVault): Promise<void> {
    return storage.set(STORAGE_KEY, vault);
}
