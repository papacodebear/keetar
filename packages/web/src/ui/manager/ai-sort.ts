import type { GroupNode } from '../../background/vault-session';

export interface AiSortAssignment {
    id: string;
    group: string;
}

export interface AiSortExport {
    text: string;
    includedCount: number;
    skippedCount: number;
}

// Title/URL/current-group only — passwords and usernames never enter this file (§8.2).
// alreadySortedUuids lets a re-run only export what's new, since entries the AI already
// categorized don't need to be shown to it again. allowConsolidation only adds language
// inviting the AI to restructure existing groups — appropriate for a full re-sort, not
// for a routine "just place the new ones" pass.
export function buildAiSortExport(
    root: GroupNode,
    recycleBinGroupUuid: string | undefined,
    alreadySortedUuids: ReadonlySet<string>,
    allowConsolidation: boolean
): AiSortExport {
    const entries: { id: string; title: string; url: string; group: string }[] = [];
    const groupNames: string[] = [];
    let skippedCount = 0;
    const walk = (group: GroupNode) => {
        if (group.uuid === recycleBinGroupUuid) {
            return;
        }
        if (group.name) {
            groupNames.push(group.name);
        }
        for (const entry of group.entries) {
            if (alreadySortedUuids.has(entry.uuid)) {
                skippedCount++;
                continue;
            }
            entries.push({ id: entry.uuid, title: entry.title, url: entry.urls[0] ?? '', group: group.name });
        }
        for (const subGroup of group.groups) {
            walk(subGroup);
        }
    };
    walk(root);

    const instructions =
        'Group these password-manager entries into logical categories based on their title/URL ' +
        '(e.g. Banking, Shopping, Work, Social, Email, Dev Tools, Utilities). Reuse an existing ' +
        '"group" value where it already fits, or invent a short new one otherwise.' +
        (allowConsolidation
            ? ' Feel free to consolidate, rename, or merge existing groups where it improves organization.'
            : '') +
        ' Respond with ONLY a JSON array, no other text, in exactly this shape:\n' +
        '[{"id": "<id>", "group": "<group name>"}]\n\n' +
        `Existing groups: ${groupNames.length > 0 ? groupNames.join(', ') : '(none yet)'}\n\n` +
        'Entries:';
    return {
        text: `${instructions}\n${JSON.stringify(entries, null, 2)}`,
        includedCount: entries.length,
        skippedCount
    };
}

// Tolerant of a chat UI wrapping the JSON in prose or a code fence.
export function parseAiSortResponse(raw: string): AiSortAssignment[] {
    const match = raw.match(/\[[\s\S]*\]/);
    let parsed: unknown;
    try {
        parsed = JSON.parse(match ? match[0] : raw);
    } catch {
        throw new Error("Couldn't parse that as JSON — make sure it's the array the prompt asked for.");
    }
    if (!Array.isArray(parsed)) {
        throw new Error('Expected a JSON array of { "id": ..., "group": ... } objects.');
    }
    return parsed.map((item) => {
        const id = (item as Record<string, unknown> | null)?.id;
        const group = (item as Record<string, unknown> | null)?.group;
        if (typeof id !== 'string' || typeof group !== 'string') {
            throw new Error('Every item must have string "id" and "group" fields.');
        }
        return { id, group };
    });
}

export interface AiSortDiffGroup {
    groupName: string;
    isNew: boolean;
    entries: { entryUuid: string; title: string }[];
}

export interface AiSortDiff {
    groups: AiSortDiffGroup[];
    unknownCount: number;
    unchangedCount: number;
    /** Every id the AI actually addressed (changed or not) — marked "sorted" once applied, unknown ids excluded. */
    consideredEntryUuids: string[];
}

// Diffs against the tree already in memory (Manager already holds the full GET_GROUP_TREE result) — no backend call needed for a preview.
export function diffAiSortAssignments(
    root: GroupNode,
    recycleBinGroupUuid: string | undefined,
    assignments: AiSortAssignment[]
): AiSortDiff {
    const entryInfo = new Map<string, { title: string; currentGroupName: string }>();
    const existingGroupNames = new Set<string>();
    const walk = (group: GroupNode) => {
        if (group.uuid === recycleBinGroupUuid) {
            return;
        }
        existingGroupNames.add(group.name.toLowerCase());
        for (const entry of group.entries) {
            entryInfo.set(entry.uuid, { title: entry.title, currentGroupName: group.name });
        }
        for (const subGroup of group.groups) {
            walk(subGroup);
        }
    };
    walk(root);

    const byGroup = new Map<string, AiSortDiffGroup>();
    let unknownCount = 0;
    let unchangedCount = 0;
    const consideredEntryUuids: string[] = [];

    for (const { id, group: proposedGroup } of assignments) {
        const info = entryInfo.get(id);
        if (!info) {
            unknownCount++;
            continue;
        }
        consideredEntryUuids.push(id);
        if (info.currentGroupName.toLowerCase() === proposedGroup.toLowerCase()) {
            unchangedCount++;
            continue;
        }
        const key = proposedGroup.toLowerCase();
        let bucket = byGroup.get(key);
        if (!bucket) {
            bucket = { groupName: proposedGroup, isNew: !existingGroupNames.has(key), entries: [] };
            byGroup.set(key, bucket);
        }
        bucket.entries.push({ entryUuid: id, title: info.title });
    }

    return { groups: Array.from(byGroup.values()), unknownCount, unchangedCount, consideredEntryUuids };
}
