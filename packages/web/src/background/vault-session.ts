import { Kdbx, KdbxCredentials, ProtectedValue } from '@keetar/core';
import type { KdbxEntry, KdbxEntryField, KdbxGroup } from '@keetar/core';
import { LocalFileProvider } from '../providers/local-file';

// In-memory decrypted vault state + lock logic (§3.4). Lives only in service
// worker module-level memory — lost on lock, lost on SW termination (both
// correct and expected per §3.4).

export interface VaultSummary {
    rootGroupName: string;
    entryCount: number;
    entryTitles: string[];
}

export interface EntrySummary {
    uuid: string;
    title: string;
    username: string;
}

export type EntryFieldName = 'username' | 'password';

type VaultSessionState =
    | { status: 'locked' }
    | { status: 'unlocked'; uuid: string; db: Kdbx };

const MAX_SUMMARY_TITLES = 20;

class VaultSession {
    private state: VaultSessionState = { status: 'locked' };

    get status(): VaultSessionState['status'] {
        return this.state.status;
    }

    async unlock(uuid: string, password: string): Promise<VaultSummary> {
        const provider = new LocalFileProvider(uuid);
        const data = await provider.read('');
        const credentials = new KdbxCredentials(ProtectedValue.fromString(password));
        const db = await Kdbx.load(data, credentials);
        this.state = { status: 'unlocked', uuid, db };
        return summarize(db);
    }

    // On lock: overwrite the key buffer with zeros, then drop the reference
    // (§3.4). The composite/derived key itself is zeroed internally by
    // @keetar/core as soon as it's consumed (kdbx-format.ts's decrypt
    // pipeline), so there's no separate key buffer for this session to zero
    // here — dropping the Kdbx reference (which holds the decrypted tree,
    // itself made of ProtectedValue-wrapped fields per §11.1) is what's left
    // to do at this layer.
    lock(): void {
        this.state = { status: 'locked' };
    }

    // Lightweight list for Popup's entry list (§8.2 — "credential
    // search/selection"). Title + username only, never the password: Popup
    // fetches an individual field on demand (getEntryField) only at the
    // moment the user actually copies it, rather than holding every entry's
    // full field set in the popup's own memory/DOM at once.
    listEntries(): EntrySummary[] {
        const db = this.requireUnlocked();
        const recycleBinUuid = db.meta.recycleBinUuid;
        const results: EntrySummary[] = [];
        const walk = (group: KdbxGroup) => {
            if (recycleBinUuid && group.uuid.equals(recycleBinUuid)) {
                return;
            }
            for (const entry of group.entries) {
                results.push({
                    uuid: entry.uuid.id,
                    title: fieldText(entry.fields.get('Title')),
                    username: fieldText(entry.fields.get('UserName'))
                });
            }
            for (const subGroup of group.groups) {
                walk(subGroup);
            }
        };
        walk(db.getDefaultGroup());
        return results;
    }

    getEntryField(entryUuid: string, field: EntryFieldName): string {
        const db = this.requireUnlocked();
        const entry = findEntry(db.getDefaultGroup(), entryUuid);
        if (!entry) {
            throw new Error('entry not found');
        }
        const fieldName = field === 'username' ? 'UserName' : 'Password';
        return fieldText(entry.fields.get(fieldName));
    }

    private requireUnlocked(): Kdbx {
        if (this.state.status !== 'unlocked') {
            throw new Error('vault is locked');
        }
        return this.state.db;
    }
}

function fieldText(field: KdbxEntryField | undefined): string {
    if (field === undefined) {
        return '';
    }
    return typeof field === 'string' ? field : field.getText();
}

function findEntry(group: KdbxGroup, uuid: string): KdbxEntry | undefined {
    for (const entry of group.entries) {
        if (entry.uuid.id === uuid) {
            return entry;
        }
    }
    for (const subGroup of group.groups) {
        const found = findEntry(subGroup, uuid);
        if (found) {
            return found;
        }
    }
    return undefined;
}

function summarize(db: Kdbx): VaultSummary {
    const root = db.getDefaultGroup();
    const titles: string[] = [];
    let entryCount = 0;
    for (const entry of root.allEntries()) {
        entryCount++;
        if (titles.length < MAX_SUMMARY_TITLES) {
            titles.push(fieldText(entry.fields.get('Title')));
        }
    }
    return {
        rootGroupName: root.name ?? '',
        entryCount,
        entryTitles: titles
    };
}

export const vaultSession = new VaultSession();
