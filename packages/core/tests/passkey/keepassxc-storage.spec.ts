import { describe, expect, test } from 'vitest';
import * as ByteUtils from '../../src/utils/byte-utils.js';
import { pkcs8ToPem } from '../../src/passkey/webauthn-crypto.js';
import {
    isKeepassxcPasskeyFieldName,
    KEEPASSXC_PASSKEY_FIELD_NAMES,
    readKeepassxcRecord,
    writeKeepassxcRecord
} from '../../src/passkey/keepassxc-storage.js';
import type { PasskeyRecord } from '../../src/passkey/record.js';

async function generateEs256Key(): Promise<{ pem: string; pkcs8: Uint8Array }> {
    const keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign'
    ])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    return { pem: pkcs8ToPem(pkcs8), pkcs8 };
}

describe('keepassxc-storage', () => {
    test('round-trips a record through write then read', async () => {
        const { pkcs8 } = await generateEs256Key();
        const record: PasskeyRecord = {
            credentialId: new Uint8Array([1, 2, 3]),
            privateKeyPkcs8: pkcs8,
            userHandle: new Uint8Array([4, 5, 6]),
            algorithm: 'ES256',
            rpId: 'example.com',
            username: 'alice',
            signCount: 5
        };

        const fields = new Map(writeKeepassxcRecord(record).map((f) => [f.name, f.value]));
        const decoded = readKeepassxcRecord(fields);

        expect(decoded).toEqual(record);
    });

    test('returns undefined when required fields are missing', () => {
        expect(readKeepassxcRecord(new Map())).toBeUndefined();
        expect(readKeepassxcRecord(new Map([['KPEX_PASSKEY_RELYING_PARTY', 'example.com']]))).toBeUndefined();
    });

    test('returns undefined instead of throwing when the values are present but malformed', () => {
        const fields = new Map([
            ['KPEX_PASSKEY_RELYING_PARTY', 'example.com'],
            ['KPEX_PASSKEY_CREDENTIAL_ID', 'not valid base64!!!'],
            ['KPEX_PASSKEY_PRIVATE_KEY_PEM', 'not a real PEM key']
        ]);
        expect(readKeepassxcRecord(fields)).toBeUndefined();
    });

    test('decodes credentialId/userHandle written as base64url, not just plain base64 (Strongbox writes this way)', async () => {
        const { pem } = await generateEs256Key();
        const credentialIdBytes = new Uint8Array([251, 255, 62, 190]); // deliberately produces '-'/'_' in base64url
        const fields = new Map([
            ['KPEX_PASSKEY_RELYING_PARTY', 'example.com'],
            ['KPEX_PASSKEY_CREDENTIAL_ID', ByteUtils.bytesToBase64Url(credentialIdBytes)],
            ['KPEX_PASSKEY_USER_HANDLE', ByteUtils.bytesToBase64Url(credentialIdBytes)],
            ['KPEX_PASSKEY_PRIVATE_KEY_PEM', pem]
        ]);
        const decoded = readKeepassxcRecord(fields);
        expect(decoded?.credentialId).toEqual(credentialIdBytes);
        expect(decoded?.userHandle).toEqual(credentialIdBytes);
    });

    test('falls back to legacy field aliases', async () => {
        const { pem } = await generateEs256Key();
        const fields = new Map([
            ['KPEX_PASSKEY_RELYING_PARTY', 'example.com'],
            ['KPXC_PASSKEY_USERNAME', 'legacy-alice'],
            ['KPEX_PASSKEY_GENERATED_USER_ID', ByteUtils.bytesToBase64(new Uint8Array([9, 9]))],
            ['KPEX_PASSKEY_PRIVATE_KEY_PEM', pem]
        ]);
        const decoded = readKeepassxcRecord(fields);
        expect(decoded?.username).toBe('legacy-alice');
        expect(decoded?.credentialId).toEqual(new Uint8Array([9, 9]));
    });

    test('defaults sign count to 0 when the Keetar extension field is absent', async () => {
        const { pem } = await generateEs256Key();
        const fields = new Map([
            ['KPEX_PASSKEY_RELYING_PARTY', 'example.com'],
            ['KPEX_PASSKEY_CREDENTIAL_ID', ByteUtils.bytesToBase64(new Uint8Array([1]))],
            ['KPEX_PASSKEY_PRIVATE_KEY_PEM', pem]
        ]);
        expect(readKeepassxcRecord(fields)?.signCount).toBe(0);
    });

    test('writeKeepassxcRecord never touches backup flags or legacy aliases', async () => {
        const { pkcs8 } = await generateEs256Key();
        const written = writeKeepassxcRecord({
            credentialId: new Uint8Array([1]),
            privateKeyPkcs8: pkcs8,
            userHandle: new Uint8Array([2]),
            algorithm: 'ES256',
            rpId: 'example.com',
            username: 'alice',
            signCount: 1
        });
        const writtenNames = new Set(written.map((f) => f.name));
        expect(writtenNames.has('KPEX_PASSKEY_FLAG_BE')).toBe(false);
        expect(writtenNames.has('KPEX_PASSKEY_FLAG_BS')).toBe(false);
        expect(writtenNames.has('KPXC_PASSKEY_USERNAME')).toBe(false);
        expect(writtenNames.has('KPEX_PASSKEY_GENERATED_USER_ID')).toBe(false);
    });

    test('protects only the sensitive fields, matching KeePassXC', async () => {
        const { pkcs8 } = await generateEs256Key();
        const written = writeKeepassxcRecord({
            credentialId: new Uint8Array([1]),
            privateKeyPkcs8: pkcs8,
            userHandle: new Uint8Array([2]),
            algorithm: 'ES256',
            rpId: 'example.com',
            username: 'alice',
            signCount: 1
        });
        const protectedNames = new Set(written.filter((f) => f.protect).map((f) => f.name));
        expect(protectedNames).toEqual(
            new Set(['KPEX_PASSKEY_USER_HANDLE', 'KPEX_PASSKEY_CREDENTIAL_ID', 'KPEX_PASSKEY_PRIVATE_KEY_PEM'])
        );
    });

    test('isKeepassxcPasskeyFieldName recognizes every listed field and rejects others', () => {
        for (const name of KEEPASSXC_PASSKEY_FIELD_NAMES) {
            expect(isKeepassxcPasskeyFieldName(name)).toBe(true);
        }
        expect(isKeepassxcPasskeyFieldName('UserName')).toBe(false);
    });
});
