import { parse as parseHostname } from 'tldts';
import { Consts } from '@keetar/core';
import type { VaultEntryRecord } from '@keetar/core';

// Cross-vault dedup: match by username + domain label (tldts, §5.4 style).
export type IdentifiedRecord = VaultEntryRecord & { uuid: string };

export interface DedupGroup {
    key: string;
    primary: IdentifiedRecord[];
    secondary: IdentifiedRecord[];
    /** 'uuid' = same entry on both sides (certain); 'heuristic' = matched by username+site (a guess). */
    origin: 'uuid' | 'heuristic';
}

/** Entries with the same login credentials, regardless of where they are filed. */
export interface ExactDuplicateGroup {
    entries: IdentifiedRecord[];
}

// Stable identity for an in-vault credential duplicate: username (case-insensitive) + password + host.
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

/** Entries to move to the recycle bin after review; every group must retain at least one entry. */
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

// Registrable domain (eTLD+1, e.g. "example.co.uk"), not domainWithoutSuffix — the latter drops
// the public suffix entirely, so example.com and example.org previously matched as "the same site".
export function matchKey(record: VaultEntryRecord): string | undefined {
    const username = record.username.trim().toLowerCase();
    if (!username) {
        return undefined;
    }
    const domain = record.url ? parseHostname(record.url).domain : null;
    if (!domain) {
        return undefined;
    }
    return `${username}|${domain.toLowerCase()}`;
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
            group = { key, primary: [], secondary: [], origin: 'heuristic' };
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

export interface UuidMatch {
    primary: IdentifiedRecord;
    secondary: IdentifiedRecord;
}

/** Same entry UUID on both sides — shared lineage, not a guess from title/username/URL. */
export function findUuidMatches(primary: IdentifiedRecord[], secondary: IdentifiedRecord[]): UuidMatch[] {
    const primaryByUuid = new Map(primary.map((record) => [record.uuid, record]));
    const matches: UuidMatch[] = [];
    for (const record of secondary) {
        const match = primaryByUuid.get(record.uuid);
        if (match) {
            matches.push({ primary: match, secondary: record });
        }
    }
    return matches;
}

/** UUID matches, wrapped as 1:1 DedupGroups so they flow through the same identical/divergent partitioning as heuristic groups. */
export function uuidMatchesToGroups(matches: UuidMatch[]): DedupGroup[] {
    return matches.map((match) => ({
        key: `uuid:${match.primary.uuid}`,
        primary: [match.primary],
        secondary: [match.secondary],
        origin: 'uuid'
    }));
}

/** Secondary-vault records that aren't part of any conflict — safe to import without asking. */
export function findNonConflicting(
    secondary: IdentifiedRecord[],
    groups: DedupGroup[]
): IdentifiedRecord[] {
    const conflictingUuids = new Set(groups.flatMap((g) => g.secondary.map((r) => r.uuid)));
    return secondary.filter((record) => !conflictingUuids.has(record.uuid));
}

// This file only has the flattened VaultEntryRecord shape, not live KdbxEntry fields/passkeys —
// the real full-field diff is supplied by the caller (vault-session.ts).
export type RecordFieldDiff = (primary: IdentifiedRecord, secondary: IdentifiedRecord) => string[];

/** True for clean 1:1 pairs with no differences reported by `diff` — nothing to reconcile. */
export function isIdenticalMatch(group: DedupGroup, diff: RecordFieldDiff): boolean {
    return group.primary.length === 1 && group.secondary.length === 1 && diff(group.primary[0], group.secondary[0]).length === 0;
}

/** Partition groups: auto-resolve pairs with no differences; require manual decision for anything that differs. */
export function partitionByIdenticalMatch(
    groups: DedupGroup[],
    diff: RecordFieldDiff
): {
    identical: DedupGroup[];
    divergent: DedupGroup[];
} {
    const identical: DedupGroup[] = [];
    const divergent: DedupGroup[] = [];
    for (const group of groups) {
        (isIdenticalMatch(group, diff) ? identical : divergent).push(group);
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
