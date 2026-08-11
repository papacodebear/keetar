import { describe, expect, test } from 'vitest';
import { parseProtonPassJson } from '../../src/import/protonpass.js';

describe('Proton Pass JSON import', () => {
    test('maps login items, keyed by vault id, using the vault name as group', () => {
        const json = JSON.stringify({
            vaults: {
                v1: {
                    name: 'Personal',
                    items: [
                        {
                            data: {
                                type: 'login',
                                metadata: { name: 'Example', note: 'hi' },
                                content: {
                                    username: 'alice',
                                    password: 'hunter2',
                                    urls: ['https://example.com'],
                                    totpUri: 'otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP'
                                }
                            }
                        }
                    ]
                }
            }
        });

        expect(parseProtonPassJson(json)).toEqual([
            {
                title: 'Example',
                username: 'alice',
                password: 'hunter2',
                url: 'https://example.com',
                notes: 'hi',
                group: 'Personal',
                totpSecret: 'otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP'
            }
        ]);
    });

    test('non-login items (notes) still produce a title/notes record', () => {
        const json = JSON.stringify({
            vaults: {
                v1: {
                    name: 'Personal',
                    items: [{ data: { type: 'note', metadata: { name: 'A Note', note: 'contents' } } }]
                }
            }
        });

        const [record] = parseProtonPassJson(json);
        expect(record.title).toBe('A Note');
        expect(record.notes).toBe('contents');
        expect(record.username).toBe('');
        expect(record.password).toBe('');
    });

    test('handles an export with no vaults', () => {
        expect(parseProtonPassJson(JSON.stringify({}))).toEqual([]);
    });
});
