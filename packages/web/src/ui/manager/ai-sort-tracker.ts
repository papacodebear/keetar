import { storage } from '../../platform';

// Which entries the AI has already categorized, per vault — lets a re-run only export what's new.

function storageKey(vaultUuid: string): string {
    return `keetar.aiSorted.${vaultUuid}`;
}

export async function getSortedEntryUuids(vaultUuid: string): Promise<Set<string>> {
    const stored = await storage.get<string[]>(storageKey(vaultUuid));
    return new Set(stored ?? []);
}

export async function markEntriesSorted(vaultUuid: string, entryUuids: string[]): Promise<void> {
    if (entryUuids.length === 0) {
        return;
    }
    const sorted = await getSortedEntryUuids(vaultUuid);
    for (const uuid of entryUuids) {
        sorted.add(uuid);
    }
    await storage.set(storageKey(vaultUuid), Array.from(sorted));
}
