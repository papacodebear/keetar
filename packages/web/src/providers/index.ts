import type { FileProvider } from '@keetar/core';
import type { ConfiguredVault } from '../config/vault-config';
import { GoogleDriveProvider } from './gdrive';
import { LocalFileProvider } from './local-file';
import { OpfsCachedProvider, type SyncStatus } from './opfs-cache';

// Provider-factory: maps ConfiguredVault.provider to FileProvider; cloud wrapped in OpfsCachedProvider for offline + conflict detection.
export function createFileProvider(vault: ConfiguredVault): FileProvider {
    switch (vault.provider) {
        case 'local-file':
            return new LocalFileProvider(vault.uuid);
        case 'gdrive':
            return new OpfsCachedProvider(vault.uuid, new GoogleDriveProvider());
    }
}

// §4.3's proactive checks callable from Options without unlocking (metadata-only or cached blob).
export async function checkVaultSyncStatus(vault: ConfiguredVault): Promise<SyncStatus> {
    if (vault.provider !== 'gdrive' || !vault.path) {
        return 'ok';
    }
    const cached = new OpfsCachedProvider(vault.uuid, new GoogleDriveProvider());
    return cached.checkSyncStatus(vault.path);
}

export async function resolveVaultSyncConflict(
    vault: ConfiguredVault,
    resolution: 'keep-local' | 'keep-cloud'
): Promise<void> {
    if (vault.provider !== 'gdrive' || !vault.path) {
        throw new Error('this vault has no sync conflict to resolve');
    }
    const cached = new OpfsCachedProvider(vault.uuid, new GoogleDriveProvider());
    await cached.resolveConflict(vault.path, resolution);
}
