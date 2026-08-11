import type { GroupNode } from '../../background/vault-session';

export interface AiSortAssignment {
    id: string;
    group: string;
}

// Title/URL/current-group only — passwords and usernames never enter this file (§8.2).
export function buildAiSortExport(root: GroupNode, recycleBinGroupUuid: string | undefined): string {
    const entries: { id: string; title: string; url: string; group: string }[] = [];
    const walk = (group: GroupNode) => {
        if (group.uuid === recycleBinGroupUuid) {
            return;
        }
        for (const entry of group.entries) {
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
        '"group" value where it already fits, or invent a short new one otherwise. Respond with ' +
        'ONLY a JSON array, no other text, in exactly this shape:\n' +
        '[{"id": "<id>", "group": "<group name>"}]\n\n' +
        'Entries:';
    return `${instructions}\n${JSON.stringify(entries, null, 2)}`;
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

    for (const { id, group: proposedGroup } of assignments) {
        const info = entryInfo.get(id);
        if (!info) {
            unknownCount++;
            continue;
        }
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

    return { groups: Array.from(byGroup.values()), unknownCount, unchangedCount };
}
