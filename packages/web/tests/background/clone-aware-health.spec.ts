import { describe, expect, test } from 'vitest';
import { applyCloneAwareness, type CloneAwareEntry } from '../../src/background/clone-aware-health';
import type { PasswordHealthFinding, PasswordHealthReport } from '@keetar/core';

function finding(overrides: Partial<PasswordHealthFinding> & { entryUuid: string }): PasswordHealthFinding {
    return {
        title: '',
        entropy: 100,
        weak: false,
        reused: false,
        old: false,
        breachCount: 0,
        similarEntryUuids: [],
        ...overrides
    };
}

function report(findings: PasswordHealthFinding[], total: number): PasswordHealthReport {
    return {
        findings,
        total,
        weak: findings.filter((f) => f.weak).length,
        reused: findings.filter((f) => f.reused).length,
        old: findings.filter((f) => f.old).length,
        breached: findings.filter((f) => f.breachCount > 0).length,
        similar: findings.filter((f) => f.similarEntryUuids.length > 0).length
    };
}

describe('clone-aware password health', () => {
    test('suppresses reused between a source and its direct clone', () => {
        const entries: CloneAwareEntry[] = [
            { uuid: 'source', password: 'shared-pw', clonedFromEntryUuid: undefined },
            { uuid: 'clone', password: 'shared-pw', clonedFromEntryUuid: 'source' }
        ];
        const input = report(
            [finding({ entryUuid: 'source', reused: true }), finding({ entryUuid: 'clone', reused: true })],
            2
        );

        const result = applyCloneAwareness(input, entries);

        expect(result.findings).toHaveLength(0);
        expect(result.reused).toBe(0);
    });

    test('still flags reuse against an entry outside the clone family', () => {
        const entries: CloneAwareEntry[] = [
            { uuid: 'source', password: 'shared-pw', clonedFromEntryUuid: undefined },
            { uuid: 'clone', password: 'shared-pw', clonedFromEntryUuid: 'source' },
            { uuid: 'unrelated', password: 'shared-pw', clonedFromEntryUuid: undefined }
        ];
        const input = report(
            [
                finding({ entryUuid: 'source', reused: true }),
                finding({ entryUuid: 'clone', reused: true }),
                finding({ entryUuid: 'unrelated', reused: true })
            ],
            3
        );

        const result = applyCloneAwareness(input, entries);

        const byUuid = new Map(result.findings.map((f) => [f.entryUuid, f]));
        expect(byUuid.get('source')?.reused).toBe(true);
        expect(byUuid.get('clone')?.reused).toBe(true);
        expect(byUuid.get('unrelated')?.reused).toBe(true);
        expect(result.reused).toBe(3);
    });

    test('treats a clone-of-a-clone chain as one family', () => {
        const entries: CloneAwareEntry[] = [
            { uuid: 'source', password: 'shared-pw', clonedFromEntryUuid: undefined },
            { uuid: 'clone1', password: 'shared-pw', clonedFromEntryUuid: 'source' },
            { uuid: 'clone2', password: 'shared-pw', clonedFromEntryUuid: 'clone1' }
        ];
        const input = report(
            [
                finding({ entryUuid: 'source', reused: true }),
                finding({ entryUuid: 'clone1', reused: true }),
                finding({ entryUuid: 'clone2', reused: true })
            ],
            3
        );

        const result = applyCloneAwareness(input, entries);

        expect(result.findings).toHaveLength(0);
        expect(result.reused).toBe(0);
    });

    test('keeps weak/old/breach flags even when reuse is suppressed', () => {
        const entries: CloneAwareEntry[] = [
            { uuid: 'source', password: 'shared-pw', clonedFromEntryUuid: undefined },
            { uuid: 'clone', password: 'shared-pw', clonedFromEntryUuid: 'source' }
        ];
        const input = report(
            [
                finding({ entryUuid: 'source', reused: true, weak: true }),
                finding({ entryUuid: 'clone', reused: true, breachCount: 3 })
            ],
            2
        );

        const result = applyCloneAwareness(input, entries);

        expect(result.findings).toHaveLength(2);
        const byUuid = new Map(result.findings.map((f) => [f.entryUuid, f]));
        expect(byUuid.get('source')).toMatchObject({ reused: false, weak: true });
        expect(byUuid.get('clone')).toMatchObject({ reused: false, breachCount: 3 });
        expect(result.weak).toBe(1);
        expect(result.breached).toBe(1);
        expect(result.reused).toBe(0);
    });

    test('leaves ordinary (non-clone) reuse detection untouched', () => {
        const entries: CloneAwareEntry[] = [
            { uuid: 'a', password: 'shared-pw', clonedFromEntryUuid: undefined },
            { uuid: 'b', password: 'shared-pw', clonedFromEntryUuid: undefined }
        ];
        const input = report([finding({ entryUuid: 'a', reused: true }), finding({ entryUuid: 'b', reused: true })], 2);

        const result = applyCloneAwareness(input, entries);

        expect(result.reused).toBe(2);
        expect(result.findings.every((f) => f.reused)).toBe(true);
    });
});
