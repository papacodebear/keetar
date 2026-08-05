import { Kdbx, KdbxCredentials, ProtectedValue } from '@keetar/core';
import { LocalFileProvider } from '../providers/local-file';

// In-memory decrypted vault state + lock logic (§3.4). Lives only in service
// worker module-level memory — lost on lock, lost on SW termination (both
// correct and expected per §3.4).

export interface VaultSummary {
    rootGroupName: string;
    entryCount: number;
    entryTitles: string[];
}

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
}

function summarize(db: Kdbx): VaultSummary {
    const root = db.getDefaultGroup();
    const titles: string[] = [];
    let entryCount = 0;
    for (const entry of root.allEntries()) {
        entryCount++;
        if (titles.length < MAX_SUMMARY_TITLES) {
            const title = entry.fields.get('Title');
            titles.push(typeof title === 'string' ? title : (title?.getText() ?? ''));
        }
    }
    return {
        rootGroupName: root.name ?? '',
        entryCount,
        entryTitles: titles
    };
}

export const vaultSession = new VaultSession();
