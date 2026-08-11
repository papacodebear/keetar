import { describe, expect, test } from 'vitest';
import { exportToCsv, parseCsv } from '../../src/import/csv.js';

describe('CSV import', () => {
    test('parses a generic header row (title/username/password/url/notes)', () => {
        const csv = 'Title,Username,Password,URL,Notes\nExample,alice,hunter2,https://example.com,hi';
        expect(parseCsv(csv)).toEqual([
            { title: 'Example', username: 'alice', password: 'hunter2', url: 'https://example.com', notes: 'hi' }
        ]);
    });

    test('parses the KeePass CSV export column set, including Group and TOTP', () => {
        const csv = 'Group,Title,Username,Password,URL,Notes,TOTP\nWork,Example,alice,hunter2,https://example.com,hi,JBSWY3DPEHPK3PXP';
        expect(parseCsv(csv)).toEqual([
            {
                title: 'Example',
                username: 'alice',
                password: 'hunter2',
                url: 'https://example.com',
                notes: 'hi',
                group: 'Work',
                totpSecret: 'JBSWY3DPEHPK3PXP'
            }
        ]);
    });

    test('matches header synonyms case-insensitively', () => {
        const csv = 'name,login,pass,website,comment\nExample,alice,hunter2,https://example.com,hi';
        expect(parseCsv(csv)).toEqual([
            { title: 'Example', username: 'alice', password: 'hunter2', url: 'https://example.com', notes: 'hi' }
        ]);
    });

    test('handles quoted fields with embedded commas, quotes, and newlines', () => {
        const csv = 'Title,Notes\n"Has, comma","Has ""quotes""\nand a newline"';
        expect(parseCsv(csv)).toEqual([
            { title: 'Has, comma', username: '', password: '', url: '', notes: 'Has "quotes"\nand a newline' }
        ]);
    });

    test('parses a tags column into an array', () => {
        const csv = 'Title,Tags\nExample,"work; personal"';
        expect(parseCsv(csv)).toEqual([
            { title: 'Example', username: '', password: '', url: '', notes: '', tags: ['work', 'personal'] }
        ]);
    });

    test('throws when no recognizable column exists', () => {
        expect(() => parseCsv('Foo,Bar\n1,2')).toThrow(/no recognizable/);
    });

    test('round-trips through exportToCsv/parseCsv', () => {
        const records = [
            { title: 'Example', username: 'alice', password: 'hunter2', url: 'https://example.com', notes: 'hi, there', group: 'Work' }
        ];
        const csv = exportToCsv(records);
        expect(parseCsv(csv)).toEqual(records);
    });
});
