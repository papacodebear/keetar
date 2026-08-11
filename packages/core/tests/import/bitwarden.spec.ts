import { describe, expect, test } from 'vitest';
import { parseBitwardenJson } from '../../src/import/bitwarden.js';

describe('Bitwarden JSON import', () => {
    test('maps login items, resolving folderId to folder name', () => {
        const json = JSON.stringify({
            folders: [{ id: 'f1', name: 'Work' }],
            items: [
                {
                    type: 1,
                    name: 'Example',
                    notes: 'hi',
                    folderId: 'f1',
                    login: {
                        username: 'alice',
                        password: 'hunter2',
                        totp: 'otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP',
                        uris: [{ uri: 'https://example.com' }]
                    }
                }
            ]
        });

        expect(parseBitwardenJson(json)).toEqual([
            {
                title: 'Example',
                username: 'alice',
                password: 'hunter2',
                url: 'https://example.com',
                notes: 'hi',
                group: 'Work',
                totpSecret: 'otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP'
            }
        ]);
    });

    test('folds non-login items (secure notes, cards) into notes rather than dropping them', () => {
        const json = JSON.stringify({
            items: [
                {
                    type: 3,
                    name: 'My Card',
                    notes: 'personal card',
                    fields: [{ name: 'Card Number', value: '4111111111111111' }]
                }
            ]
        });

        const [record] = parseBitwardenJson(json);
        expect(record.title).toBe('My Card');
        expect(record.username).toBe('');
        expect(record.password).toBe('');
        expect(record.notes).toContain('personal card');
        expect(record.notes).toContain('Card Number: 4111111111111111');
    });

    test('handles items with no folder and no totp gracefully', () => {
        const json = JSON.stringify({
            items: [{ type: 1, name: 'Bare', login: { username: 'u', password: 'p' } }]
        });
        expect(parseBitwardenJson(json)).toEqual([
            { title: 'Bare', username: 'u', password: 'p', url: '', notes: '', group: undefined, totpSecret: undefined }
        ]);
    });
});
