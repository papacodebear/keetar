import { parse as parseHostname } from 'tldts';
import { Consts } from '@keetar/core';
import type { VaultEntryRecord } from '@keetar/core';

// Cross-vault dedup: match by username + domain label (tldts, §5.4 style).
export type IdentifiedRecord = VaultEntryRecord & { uuid: string };

export interface DedupGroup {
    key: string;
    primary: IdentifiedRecord[];
    secondary: IdentifiedRecord[];
}

/** Entries with the same login credentials, regardless of where they are filed. */
export interface ExactDuplicateGroup {
    entries: IdentifiedRecord[];
}

/**
 * Produces a stable identity for an in-vault credential duplicate.
 *
 * Username comparison is case-insensitive, while passwords remain exact. URLs
 * are reduced to their host, so harmless presentation differences (scheme,
 * `www.`, port, path, query string, and fragment) do not hide a duplicate.
 * Different hosts remain distinct. Sparse entries without a complete
 * username-and-host identity fall back to their normalized title and password.
 */
function duplicateCredentialKey(record: VaultEntryRecord): string | undefined {
    const username = record.username.trim().toLowerCase();
    const password = record.password;
    if (!password) {
        return undefined;
    }

    const hostname = normalizeCredentialUrl(record.url);
    if (username && hostname) {
        return `credentials\u0000${username}\u0000${password}\u0000${hostname}`;
    }

    const title = record.title.trim().toLowerCase();
    return title ? `title-password\u0000${title}\u0000${password}` : undefined;
}

function normalizeCredentialUrl(value: string): string | undefined {
    const url = value.trim();
    if (!url) {
        return undefined;
    }

    try {
        const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `https://${url}`);
        if (!parsed.hostname) {
            return url;
        }
        return parsed.hostname.replace(/^www\./i, '');
    } catch {
        // Keep malformed but non-empty URLs matchable only by their literal value.
        return url;
    }
}

function groupRecordsByKey(
    records: IdentifiedRecord[],
    keyForRecord: (record: IdentifiedRecord) => string | undefined
): Map<string, IdentifiedRecord[]> {
    const groups = new Map<string, IdentifiedRecord[]>();
    for (const record of records) {
        const key = keyForRecord(record);
        if (!key) {
            continue;
        }
        const entries = groups.get(key);
        if (entries) {
            entries.push(record);
        } else {
            groups.set(key, [record]);
        }
    }
    return groups;
}

/** Finds equivalent credential duplicates inside one vault. Group paths intentionally do not affect identity. */
export function findExactDuplicateGroups(records: IdentifiedRecord[]): ExactDuplicateGroup[] {
    return Array.from(groupRecordsByKey(records, duplicateCredentialKey).values())
        .filter((entries) => entries.length > 1)
        .map((entries) => ({ entries }));
}

/**
 * Returns the entries to move to the recycle bin after the user reviews each
 * duplicate group. Multiple entries may be retained, but every group must
 * retain at least one entry.
 */
export function entriesToRemoveFromDuplicateGroups(
    groups: ExactDuplicateGroup[],
    keepEntryUuids: Iterable<string>
): IdentifiedRecord[] {
    const keptUuids = new Set(keepEntryUuids);
    const duplicateUuids = new Set(groups.flatMap((group) => group.entries.map((entry) => entry.uuid)));
    if (Array.from(keptUuids).some((uuid) => !duplicateUuids.has(uuid))) {
        throw new Error('choose only entries from the current duplicate sets');
    }

    const entriesToRemove: IdentifiedRecord[] = [];
    for (const group of groups) {
        const keptEntries = group.entries.filter((entry) => keptUuids.has(entry.uuid));
        if (keptEntries.length === 0) {
            throw new Error('keep at least one entry from each duplicate set');
        }
        entriesToRemove.push(...group.entries.filter((entry) => !keptUuids.has(entry.uuid)));
    }
    return entriesToRemove;
}

/** Incoming records whose complete credentials already exist in the primary vault. */
export function findExactDuplicateMatches(
    primary: IdentifiedRecord[],
    secondary: IdentifiedRecord[]
): { primary: IdentifiedRecord; secondary: IdentifiedRecord }[] {
    const primaryByKey = groupRecordsByKey(primary, duplicateCredentialKey);
    const matches: { primary: IdentifiedRecord; secondary: IdentifiedRecord }[] = [];
    for (const record of secondary) {
        const key = duplicateCredentialKey(record);
        const primaryRecord = key ? primaryByKey.get(key)?.[0] : undefined;
        if (primaryRecord) {
            matches.push({ primary: primaryRecord, secondary: record });
        }
    }
    return matches;
}

export function matchKey(record: VaultEntryRecord): string | undefined {
    const username = record.username.trim().toLowerCase();
    if (!username) {
        return undefined;
    }
    const domainLabel = record.url ? parseHostname(record.url).domainWithoutSuffix : null;
    if (!domainLabel) {
        return undefined;
    }
    return `${username}|${domainLabel.toLowerCase()}`;
}

/** Groups records from two vaults by matching key; only keys on both sides returned. */
export function findDuplicateGroups(
    primary: IdentifiedRecord[],
    secondary: IdentifiedRecord[]
): DedupGroup[] {
    const byKey = new Map<string, DedupGroup>();

    const bucket = (record: IdentifiedRecord, side: 'primary' | 'secondary') => {
        const key = matchKey(record);
        if (!key) {
            return;
        }
        let group = byKey.get(key);
        if (!group) {
            group = { key, primary: [], secondary: [] };
            byKey.set(key, group);
        }
        group[side].push(record);
    };

    for (const record of primary) {
        bucket(record, 'primary');
    }
    for (const record of secondary) {
        bucket(record, 'secondary');
    }

    return Array.from(byKey.values()).filter((group) => group.primary.length > 0 && group.secondary.length > 0);
}

/** Secondary-vault records that aren't part of any conflict — safe to import without asking. */
export function findNonConflicting(
    secondary: IdentifiedRecord[],
    groups: DedupGroup[]
): IdentifiedRecord[] {
    const conflictingUuids = new Set(groups.flatMap((g) => g.secondary.map((r) => r.uuid)));
    return secondary.filter((record) => !conflictingUuids.has(record.uuid));
}

/** True for clean 1:1 pairs with identical passwords (genuinely unchanged entries). */
export function isIdenticalMatch(group: DedupGroup): boolean {
    return (
        group.primary.length === 1 &&
        group.secondary.length === 1 &&
        group.primary[0].password === group.secondary[0].password
    );
}

/** Partition groups: auto-resolve identical pairs; require manual decision for divergent ones. */
export function partitionByPasswordMatch(groups: DedupGroup[]): {
    identical: DedupGroup[];
    divergent: DedupGroup[];
} {
    const identical: DedupGroup[] = [];
    const divergent: DedupGroup[] = [];
    for (const group of groups) {
        (isIdenticalMatch(group) ? identical : divergent).push(group);
    }
    return { identical, divergent };
}

// Additive merge: empty yields to populated; conflicts fall back to preferSecondary.
export function mergeStringField(primaryValue: string, secondaryValue: string, preferSecondary: boolean): string {
    if (!secondaryValue) {
        return primaryValue;
    }
    if (!primaryValue) {
        return secondaryValue;
    }
    if (primaryValue === secondaryValue) {
        return primaryValue;
    }
    return preferSecondary ? secondaryValue : primaryValue;
}

// Icon 0 (default key) treated as unset for merge purposes.
export function mergeIcon(
    primaryIcon: number | undefined,
    secondaryIcon: number | undefined,
    preferSecondary: boolean
): number | undefined {
    const primaryIsDefault = primaryIcon === undefined || primaryIcon === Consts.Icons.Key;
    const secondaryIsDefault = secondaryIcon === undefined || secondaryIcon === Consts.Icons.Key;
    if (secondaryIsDefault) {
        return primaryIcon;
    }
    if (primaryIsDefault) {
        return secondaryIcon;
    }
    if (primaryIcon === secondaryIcon) {
        return primaryIcon;
    }
    return preferSecondary ? secondaryIcon : primaryIcon;
}
