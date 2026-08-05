import { describe, expect, test, vi } from 'vitest';
import { analysePasswordHealth, estimatePasswordEntropy } from '../../src/health/analyser.js';

describe('password health analysis', () => {
    test('reports weak, reused, old, and breached entries without returning passwords', async () => {
        const checkPasswordBreach = vi.fn(async (password: string) => (password === 'CompromisedPass1!' ? 42 : 0));
        const report = await analysePasswordHealth(
            [
                {
                    uuid: 'weak',
                    title: 'Weak password',
                    password: 'short',
                    lastModified: new Date('2025-08-05T00:00:00Z')
                },
                {
                    uuid: 'reused-a',
                    title: 'Reused A',
                    password: 'GoodSharedPass1!',
                    lastModified: new Date('2026-08-05T00:00:00Z')
                },
                {
                    uuid: 'reused-b',
                    title: 'Reused B',
                    password: 'GoodSharedPass1!',
                    lastModified: new Date('2026-08-05T00:00:00Z')
                },
                {
                    uuid: 'breached',
                    title: 'Breached password',
                    password: 'CompromisedPass1!',
                    lastModified: new Date('2026-08-05T00:00:00Z')
                }
            ],
            checkPasswordBreach,
            new Date('2026-08-05T00:00:00Z')
        );

        expect(report).toEqual({
            findings: [
                { entryUuid: 'weak', title: 'Weak password', entropy: expect.any(Number), weak: true, reused: false, old: true, breachCount: 0 },
                { entryUuid: 'reused-a', title: 'Reused A', entropy: expect.any(Number), weak: expect.any(Boolean), reused: true, old: false, breachCount: 0 },
                { entryUuid: 'reused-b', title: 'Reused B', entropy: expect.any(Number), weak: expect.any(Boolean), reused: true, old: false, breachCount: 0 },
                { entryUuid: 'breached', title: 'Breached password', entropy: expect.any(Number), weak: expect.any(Boolean), reused: false, old: false, breachCount: 42 }
            ],
            total: 4,
            weak: 4,
            reused: 2,
            old: 1,
            breached: 1
        });
        expect(checkPasswordBreach).toHaveBeenCalledTimes(3);
        expect(JSON.stringify(report)).not.toContain('CompromisedPass1!');
    });

    test('uses zxcvbn entropy with KeePassXC\'s 256-character extrapolation rule', async () => {
        const first256Characters = 'correct horse battery staple '.repeat(10).slice(0, 256);
        const password = `${first256Characters}with-extra-characters`;
        const entropy = await estimatePasswordEntropy(first256Characters);

        expect(entropy).toBeGreaterThan(0);
        await expect(estimatePasswordEntropy(password)).resolves.toBeCloseTo((entropy / 256) * password.length, 8);
    });

    test('uses KeePassXC\'s 75-bit threshold for weak passwords', async () => {
        const report = await analysePasswordHealth(
            [
                { uuid: 'weak', title: 'Weak', password: 'Yohb2ChR4' },
                {
                    uuid: 'strong',
                    title: 'Strong',
                    password: 'prompter-ream-oversleep-step-extortion-quarrel-reflected-prefix'
                }
            ],
            async () => 0
        );

        expect(report.findings).toEqual([
            expect.objectContaining({ entryUuid: 'weak', weak: true })
        ]);
    });
});