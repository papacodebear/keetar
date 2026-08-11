import { describe, expect, test } from 'vitest';
import { buildAiSortExport, diffAiSortAssignments, parseAiSortResponse } from '../../../src/ui/manager/ai-sort';
import type { EntrySummary, GroupNode } from '../../../src/background/vault-session';

function entry(overrides: Partial<EntrySummary>): EntrySummary {
    return {
        uuid: 'uuid',
        title: '',
        username: '',
        urls: [],
        hasTotp: false,
        icon: 0,
        hasCustomIcon: false,
        ...overrides
    };
}

function group(overrides: Partial<GroupNode>): GroupNode {
    return {
        uuid: 'group-uuid',
        name: '',
        groups: [],
        entries: [],
        ...overrides
    };
}

const root = group({
    uuid: 'root',
    name: 'Root',
    entries: [entry({ uuid: 'e1', title: 'GitHub', urls: ['https://github.com'] })],
    groups: [
        group({
            uuid: 'work',
            name: 'Work',
            entries: [entry({ uuid: 'e2', title: 'Jira', urls: ['https://jira.example.com'] })]
        }),
        group({
            uuid: 'recycle-bin',
            name: 'Recycle Bin',
            entries: [entry({ uuid: 'e3', title: 'Old Site', urls: ['https://old.example.com'] })]
        })
    ]
});

describe('buildAiSortExport', () => {
    function entriesJson(output: string): unknown[] {
        return JSON.parse(output.slice(output.indexOf('Entries:') + 'Entries:'.length)) as unknown[];
    }

    test('includes entries from every non-recycle-bin group, with id/title/url/group', () => {
        const json = entriesJson(buildAiSortExport(root, 'recycle-bin'));
        expect(json).toEqual([
            { id: 'e1', title: 'GitHub', url: 'https://github.com', group: 'Root' },
            { id: 'e2', title: 'Jira', url: 'https://jira.example.com', group: 'Work' }
        ]);
    });

    test('never includes username or password fields', () => {
        const json = entriesJson(buildAiSortExport(root, 'recycle-bin'));
        expect(JSON.stringify(json)).not.toContain('username');
        expect(JSON.stringify(json)).not.toContain('password');
    });
});

describe('parseAiSortResponse', () => {
    test('parses a bare JSON array', () => {
        expect(parseAiSortResponse('[{"id": "e1", "group": "Dev"}]')).toEqual([{ id: 'e1', group: 'Dev' }]);
    });

    test('extracts the array from surrounding prose or a code fence', () => {
        const wrapped = 'Sure, here you go:\n```json\n[{"id": "e1", "group": "Dev"}]\n```\nHope that helps!';
        expect(parseAiSortResponse(wrapped)).toEqual([{ id: 'e1', group: 'Dev' }]);
    });

    test('throws on invalid JSON', () => {
        expect(() => parseAiSortResponse('not json at all')).toThrow();
    });

    test('throws when an item is missing id or group', () => {
        expect(() => parseAiSortResponse('[{"id": "e1"}]')).toThrow();
    });
});

describe('diffAiSortAssignments', () => {
    test('matches an existing group name case-insensitively, and flags a new name as new', () => {
        const diff = diffAiSortAssignments(root, 'recycle-bin', [
            { id: 'e1', group: 'work' },
            { id: 'e2', group: 'Dev Tools' }
        ]);
        const work = diff.groups.find((g) => g.groupName.toLowerCase() === 'work');
        const devTools = diff.groups.find((g) => g.groupName === 'Dev Tools');
        expect(work?.isNew).toBe(false);
        expect(work?.entries).toEqual([{ entryUuid: 'e1', title: 'GitHub' }]);
        expect(devTools?.isNew).toBe(true);
        expect(devTools?.entries).toEqual([{ entryUuid: 'e2', title: 'Jira' }]);
    });

    test('skips and counts an unknown entry id', () => {
        const diff = diffAiSortAssignments(root, 'recycle-bin', [{ id: 'does-not-exist', group: 'Work' }]);
        expect(diff.groups).toEqual([]);
        expect(diff.unknownCount).toBe(1);
    });

    test('skips and counts a no-op assignment (already in that group)', () => {
        const diff = diffAiSortAssignments(root, 'recycle-bin', [{ id: 'e2', group: 'Work' }]);
        expect(diff.groups).toEqual([]);
        expect(diff.unchangedCount).toBe(1);
    });

    test('an entry in the recycle bin is treated as unknown, not reassignable', () => {
        const diff = diffAiSortAssignments(root, 'recycle-bin', [{ id: 'e3', group: 'Work' }]);
        expect(diff.groups).toEqual([]);
        expect(diff.unknownCount).toBe(1);
    });
});
