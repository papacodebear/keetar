import { describe, expect, test } from 'vitest';
import {
    findExactDuplicateGroups,
    findExactDuplicateMatches,
    findDuplicateGroups,
    findNonConflicting,
    isIdenticalMatch,
    matchKey,
    mergeIcon,
    mergeStringField,
    partitionByPasswordMatch
} from '../../src/background/dedup';
import type { IdentifiedRecord } from '../../src/background/dedup';

function record(overrides: Partial<IdentifiedRecord>): IdentifiedRecord {
    return {
        uuid: 'uuid',
        title: '',
        username: '',
        password: '',
        url: '',
        notes: '',
        ...overrides
    };
}

describe('exact credential duplicates', () => {
    test('groups matching username, password, and URL even when group paths differ', () => {
        const groups = findExactDuplicateGroups([
            record({
                uuid: 'personal',
                username: 'alice',
                password: 'correct-horse',
                url: 'https://example.com/login',
                group: 'Personal'
            }),
            record({
                uuid: 'work',
                username: 'alice',
                password: 'correct-horse',
                url: 'https://example.com/login',
                group: 'Work/Shared'
            })
        ]);

        expect(groups).toHaveLength(1);
        expect(groups[0].entries.map((entry) => entry.uuid)).toEqual(['personal', 'work']);
    });

    test('does not match records missing a credential field', () => {
        expect(
            findExactDuplicateGroups([
                record({ uuid: 'a', username: 'alice', password: 'same', url: '' }),
                record({ uuid: 'b', username: 'alice', password: 'same', url: '' })
            ])
        ).toEqual([]);
    });

    test('finds incoming exact matches before broader combine conflict matching', () => {
        const matches = findExactDuplicateMatches(
            [record({ uuid: 'primary', username: 'alice', password: 'same', url: 'https://example.com' })],
            [record({ uuid: 'secondary', username: 'alice', password: 'same', url: 'https://example.com', group: 'Elsewhere' })]
        );

        expect(matches).toEqual([
            expect.objectContaining({ primary: expect.objectContaining({ uuid: 'primary' }), secondary: expect.objectContaining({ uuid: 'secondary' }) })
        ]);
    });
});

describe('matchKey', () => {
    test('ignores scheme, subdomain, and public suffix', () => {
        const a = matchKey(record({ username: 'alice', url: 'https://login.example.com/path' }));
        const b = matchKey(record({ username: 'alice', url: 'http://example.org' }));
        expect(a).toBeDefined();
        expect(a).toBe(b);
    });

    test('is case-insensitive on username and domain', () => {
        const a = matchKey(record({ username: 'Alice', url: 'https://Example.com' }));
        const b = matchKey(record({ username: 'alice', url: 'https://example.com' }));
        expect(a).toBe(b);
    });

    test('handles multi-part suffixes like .co.uk the same as .com', () => {
        const a = matchKey(record({ username: 'alice', url: 'https://example.co.uk' }));
        const b = matchKey(record({ username: 'alice', url: 'https://example.com' }));
        expect(a).toBe(b);
    });

    test('returns undefined when username is missing', () => {
        expect(matchKey(record({ username: '', url: 'https://example.com' }))).toBeUndefined();
    });

    test('returns undefined when URL is missing or unparseable', () => {
        expect(matchKey(record({ username: 'alice', url: '' }))).toBeUndefined();
        expect(matchKey(record({ username: 'alice', url: 'not a url' }))).toBeUndefined();
    });

    test('different domain labels produce different keys', () => {
        const a = matchKey(record({ username: 'alice', url: 'https://example.com' }));
        const b = matchKey(record({ username: 'alice', url: 'https://other.com' }));
        expect(a).not.toBe(b);
    });
});

describe('findDuplicateGroups', () => {
    test('groups matching entries from both sides, skipping entries unique to one side', () => {
        const primary = [
            record({ uuid: 'p1', title: 'Example (old)', username: 'alice', url: 'https://example.com' }),
            record({ uuid: 'p2', title: 'Only in primary', username: 'bob', url: 'https://only-primary.com' })
        ];
        const secondary = [
            record({ uuid: 's1', title: 'Example (new)', username: 'alice', url: 'https://login.example.com' }),
            record({ uuid: 's2', title: 'Only in secondary', username: 'carol', url: 'https://only-secondary.com' })
        ];

        const groups = findDuplicateGroups(primary, secondary);
        expect(groups).toHaveLength(1);
        expect(groups[0].primary.map((r) => r.uuid)).toEqual(['p1']);
        expect(groups[0].secondary.map((r) => r.uuid)).toEqual(['s1']);
    });

    test('returns no groups when nothing matches', () => {
        const primary = [record({ uuid: 'p1', username: 'alice', url: 'https://example.com' })];
        const secondary = [record({ uuid: 's1', username: 'bob', url: 'https://example.com' })];
        expect(findDuplicateGroups(primary, secondary)).toEqual([]);
    });

    test('entries missing a matchable key never form a group', () => {
        const primary = [record({ uuid: 'p1', username: '', url: '' })];
        const secondary = [record({ uuid: 's1', username: '', url: '' })];
        expect(findDuplicateGroups(primary, secondary)).toEqual([]);
    });

    test('groups multiple entries sharing the same key on one side', () => {
        const primary = [record({ uuid: 'p1', username: 'alice', url: 'https://example.com' })];
        const secondary = [
            record({ uuid: 's1', username: 'alice', url: 'https://example.com' }),
            record({ uuid: 's2', username: 'alice', url: 'https://example.org' })
        ];
        const groups = findDuplicateGroups(primary, secondary);
        expect(groups).toHaveLength(1);
        expect(groups[0].secondary.map((r) => r.uuid).sort()).toEqual(['s1', 's2']);
    });
});

describe('findNonConflicting', () => {
    test('excludes secondary records that are part of a conflict group', () => {
        const secondary = [
            record({ uuid: 's1', username: 'alice', url: 'https://example.com' }),
            record({ uuid: 's2', username: 'carol', url: 'https://only-secondary.com' })
        ];
        const groups = findDuplicateGroups(
            [record({ uuid: 'p1', username: 'alice', url: 'https://example.com' })],
            secondary
        );
        expect(findNonConflicting(secondary, groups).map((r) => r.uuid)).toEqual(['s2']);
    });

    test('returns everything when there are no conflict groups', () => {
        const secondary = [record({ uuid: 's1', username: 'alice', url: 'https://example.com' })];
        expect(findNonConflicting(secondary, [])).toEqual(secondary);
    });
});

describe('isIdenticalMatch', () => {
    test('true for a 1:1 pair with the same password', () => {
        const [group] = findDuplicateGroups(
            [record({ uuid: 'p1', username: 'alice', url: 'https://example.com', password: 'hunter2' })],
            [record({ uuid: 's1', username: 'alice', url: 'https://example.com', password: 'hunter2' })]
        );
        expect(isIdenticalMatch(group)).toBe(true);
    });

    test('false for a 1:1 pair whose password diverged', () => {
        const [group] = findDuplicateGroups(
            [record({ uuid: 'p1', username: 'alice', url: 'https://example.com', password: 'old-pass' })],
            [record({ uuid: 's1', username: 'alice', url: 'https://example.com', password: 'new-pass' })]
        );
        expect(isIdenticalMatch(group)).toBe(false);
    });

    test('false when either side has more than one entry, even with matching passwords', () => {
        const [group] = findDuplicateGroups(
            [
                record({ uuid: 'p1', username: 'alice', url: 'https://example.com', password: 'hunter2' }),
                record({ uuid: 'p2', username: 'alice', url: 'https://example.org', password: 'hunter2' })
            ],
            [record({ uuid: 's1', username: 'alice', url: 'https://example.com', password: 'hunter2' })]
        );
        expect(isIdenticalMatch(group)).toBe(false);
    });
});

describe('partitionByPasswordMatch', () => {
    test('separates identical pairs from ones needing review', () => {
        const groups = findDuplicateGroups(
            [
                record({ uuid: 'p1', username: 'alice', url: 'https://unchanged.com', password: 'same' }),
                record({ uuid: 'p2', username: 'bob', url: 'https://changed.com', password: 'old-pass' })
            ],
            [
                record({ uuid: 's1', username: 'alice', url: 'https://unchanged.com', password: 'same' }),
                record({ uuid: 's2', username: 'bob', url: 'https://changed.com', password: 'new-pass' })
            ]
        );

        const { identical, divergent } = partitionByPasswordMatch(groups);
        expect(identical.map((g) => g.key)).toEqual(['alice|unchanged']);
        expect(divergent.map((g) => g.key)).toEqual(['bob|changed']);
    });
});

describe('mergeStringField', () => {
    test('takes the secondary value when the primary is empty', () => {
        expect(mergeStringField('', 'notes from secondary', false)).toBe('notes from secondary');
    });

    test('keeps the primary value when the secondary is empty', () => {
        expect(mergeStringField('notes from primary', '', true)).toBe('notes from primary');
    });

    test('keeps the shared value when both sides agree', () => {
        expect(mergeStringField('same', 'same', true)).toBe('same');
    });

    test('on a genuine conflict, preferSecondary picks the incoming value', () => {
        expect(mergeStringField('old', 'new', true)).toBe('new');
    });

    test('on a genuine conflict, !preferSecondary keeps the existing value', () => {
        expect(mergeStringField('old', 'new', false)).toBe('old');
    });

    test('both empty stays empty', () => {
        expect(mergeStringField('', '', true)).toBe('');
    });
});

describe('mergeIcon', () => {
    const KEY_ICON = 0; // Consts.Icons.Key — every entry's default at creation

    test('a customized secondary icon wins over an unset/default primary', () => {
        expect(mergeIcon(undefined, 7, false)).toBe(7);
        expect(mergeIcon(KEY_ICON, 7, false)).toBe(7);
    });

    test('a customized primary icon is kept over an unset/default secondary', () => {
        expect(mergeIcon(7, undefined, true)).toBe(7);
        expect(mergeIcon(7, KEY_ICON, true)).toBe(7);
    });

    test('both default stays default', () => {
        expect(mergeIcon(undefined, undefined, true)).toBeUndefined();
        expect(mergeIcon(KEY_ICON, KEY_ICON, true)).toBe(KEY_ICON);
    });

    test('both customized and equal keeps that icon', () => {
        expect(mergeIcon(9, 9, true)).toBe(9);
    });

    test('both customized and different: preferSecondary breaks the tie', () => {
        expect(mergeIcon(9, 12, true)).toBe(12);
        expect(mergeIcon(9, 12, false)).toBe(9);
    });
});
