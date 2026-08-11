import { strToU8, zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { parseOnePux } from '../../src/import/onepassword.js';

function buildOnePux(exportData: unknown): Uint8Array {
    return zipSync({ 'export.data': strToU8(JSON.stringify(exportData)) });
}

describe('1Password 1PUX import', () => {
    test('maps login items from account/vault/item hierarchy', () => {
        const archive = buildOnePux({
            accounts: [
                {
                    vaults: [
                        {
                            attrs: { name: 'Personal' },
                            items: [
                                {
                                    categoryUuid: '001',
                                    overview: { title: 'Example', url: 'https://example.com', tags: ['a'] },
                                    details: {
                                        loginFields: [
                                            { designation: 'username', value: 'alice' },
                                            { designation: 'password', value: 'hunter2' }
                                        ],
                                        notesPlain: 'hi'
                                    }
                                }
                            ]
                        }
                    ]
                }
            ]
        });

        expect(parseOnePux(archive)).toEqual([
            {
                title: 'Example',
                username: 'alice',
                password: 'hunter2',
                url: 'https://example.com',
                notes: 'hi',
                group: 'Personal',
                tags: ['a']
            }
        ]);
    });

    test('falls back to details.password when no loginFields designation matches', () => {
        const archive = buildOnePux({
            accounts: [
                {
                    vaults: [
                        {
                            items: [
                                {
                                    categoryUuid: '005',
                                    overview: { title: 'Legacy Password' },
                                    details: { password: 'legacy-pass' }
                                }
                            ]
                        }
                    ]
                }
            ]
        });

        const [record] = parseOnePux(archive);
        expect(record.password).toBe('legacy-pass');
        expect(record.username).toBe('');
    });

    test('non-login categories still produce a title/notes record, not username/password', () => {
        const archive = buildOnePux({
            accounts: [
                {
                    vaults: [
                        {
                            items: [
                                {
                                    categoryUuid: '003',
                                    overview: { title: 'Secure Note' },
                                    details: { notesPlain: 'secret note', password: 'should-be-ignored' }
                                }
                            ]
                        }
                    ]
                }
            ]
        });

        const [record] = parseOnePux(archive);
        expect(record.title).toBe('Secure Note');
        expect(record.notes).toBe('secret note');
        expect(record.password).toBe('');
    });

    test('throws a clear error when export.data is missing from the archive', () => {
        const archive = zipSync({ 'other-file.txt': strToU8('not an export') });
        expect(() => parseOnePux(archive)).toThrow(/export\.data/);
    });
});
