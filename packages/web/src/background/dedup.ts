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
