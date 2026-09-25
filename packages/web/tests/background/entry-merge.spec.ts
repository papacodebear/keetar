import { beforeAll, describe, expect, test } from 'vitest';
import {
    Kdbx,
    KdbxCredentials,
    KeepassxcPasskeyStorage,
    NativePasskeyStorage,
    ProtectedValue,
    WebauthnCrypto
} from '@keetar/core';
import type { KdbxEntry } from '@keetar/core';
import { entryFieldDiff, mergeCustomFields, mergeKeepassxcPasskeyFields, mergeNativePasskeyIndex } from '../../src/background/entry-merge';

function createDb(): Kdbx {
    return Kdbx.create(new KdbxCredentials(ProtectedValue.fromString('test')), 'Test');
}

function entry(db: Kdbx, fields: Record<string, string> = {}): KdbxEntry {
    const e = db.createEntry(db.getDefaultGroup());
    for (const [name, value] of Object.entries(fields)) {
        e.fields.set(name, value);
    }
    return e;
}

describe('entryFieldDiff', () => {
    test('empty when every field matches', () => {
        const db = createDb();
        const a = entry(db, { Title: 'Site', UserName: 'alice', Password: 'p' });
        const b = entry(db, { Title: 'Site', UserName: 'alice', Password: 'p' });
        expect(entryFieldDiff(a, b)).toEqual([]);
    });

    test('reports standard field differences by name', () => {
        const db = createDb();
        const a = entry(db, { Title: 'Old', UserName: 'alice' });
        const b = entry(db, { Title: 'New', UserName: 'alice' });
        expect(entryFieldDiff(a, b)).toEqual(['title']);
    });

    // The whole point of moving off a hardcoded field list: a custom field difference must be
    // visible too, not just the five standard ones.
    test('reports a custom field difference the standard field list has never heard of', () => {
        const db = createDb();
        const a = entry(db, { Title: 'Site', 'Security Question': 'first pet' });
        const b = entry(db, { Title: 'Site', 'Security Question': 'maiden name' });
        expect(entryFieldDiff(a, b)).toEqual(['Security Question']);
    });

    test('reports a custom field present on only one side', () => {
        const db = createDb();
        const a = entry(db, { Title: 'Site' });
        const b = entry(db, { Title: 'Site', 'PIN': '1234' });
        expect(entryFieldDiff(a, b)).toEqual(['PIN']);
    });

    test('reports a one-time code difference under a stable label, whichever field name holds it', () => {
        const db = createDb();
        const a = entry(db, { otp: 'otpauth://totp/a?secret=AAAA' });
        const b = entry(db, { 'TOTP Seed': 'BBBB' });
        expect(entryFieldDiff(a, b)).toEqual(['one-time code']);
    });

    test('reports a passkey difference when the credential sets differ', () => {
        const db = createDb();
        const a = entry(db, {});
        a.fields.set(
            NativePasskeyStorage.PASSKEY_INDEX_FIELD,
            NativePasskeyStorage.serializePasskeyIndex([{ credentialId: 'cred-a', rpId: 'example.com' }])
        );
        const b = entry(db, {});
        expect(entryFieldDiff(a, b)).toEqual(['passkey']);
    });

    test('no passkey difference when both sides have the same credential', () => {
        const db = createDb();
        const index = NativePasskeyStorage.serializePasskeyIndex([{ credentialId: 'cred-a', rpId: 'example.com' }]);
        const a = entry(db, { [NativePasskeyStorage.PASSKEY_INDEX_FIELD]: index });
        const b = entry(db, { [NativePasskeyStorage.PASSKEY_INDEX_FIELD]: index });
        expect(entryFieldDiff(a, b)).toEqual([]);
    });
});

describe('mergeCustomFields', () => {
    test('additively copies a custom field the target is missing', () => {
        const db = createDb();
        const target = entry(db, { Title: 'Site' });
        const source = entry(db, { Title: 'Site', 'Security Question': 'first pet' });

        mergeCustomFields(target, source, false);

        expect(target.fields.get('Security Question')).toBe('first pet');
    });

    test('never touches standard, TOTP, or passkey fields — those have their own dedicated handling', () => {
        const db = createDb();
        const target = entry(db, { Title: 'Existing title', otp: 'existing-otp' });
        const source = entry(db, { Title: 'Incoming title', otp: 'incoming-otp' });
        source.fields.set(NativePasskeyStorage.PASSKEY_INDEX_FIELD, 'should-not-copy-raw');

        mergeCustomFields(target, source, true);

        expect(target.fields.get('Title')).toBe('Existing title');
        expect(target.fields.get('otp')).toBe('existing-otp');
        expect(target.fields.has(NativePasskeyStorage.PASSKEY_INDEX_FIELD)).toBe(false);
    });

    test('a genuine conflict on the same custom field falls back to preferSecondary', () => {
        const db = createDb();
        const target = entry(db, { PIN: '1111' });
        const source = entry(db, { PIN: '2222' });

        mergeCustomFields(target, source, true);
        expect(target.fields.get('PIN')).toBe('2222');

        const targetB = entry(db, { PIN: '1111' });
        const sourceB = entry(db, { PIN: '2222' });
        mergeCustomFields(targetB, sourceB, false);
        expect(targetB.fields.get('PIN')).toBe('1111');
    });

    test('preserves the protected flag of whichever side wins', () => {
        const db = createDb();
        const target = entry(db, {});
        const source = entry(db, {});
        source.fields.set('API Key', ProtectedValue.fromString('secret-value'));

        mergeCustomFields(target, source, true);

        expect(target.fields.get('API Key')).toBeInstanceOf(ProtectedValue);
    });
});

describe('mergeNativePasskeyIndex', () => {
    test('unions credentials present on either side', () => {
        const db = createDb();
        const target = entry(db, {
            [NativePasskeyStorage.PASSKEY_INDEX_FIELD]: NativePasskeyStorage.serializePasskeyIndex([
                { credentialId: 'cred-a', rpId: 'a.example.com' }
            ])
        });
        const source = entry(db, {
            [NativePasskeyStorage.PASSKEY_INDEX_FIELD]: NativePasskeyStorage.serializePasskeyIndex([
                { credentialId: 'cred-b', rpId: 'b.example.com' }
            ])
        });

        mergeNativePasskeyIndex(target, source);

        const merged = NativePasskeyStorage.parsePasskeyIndex(target.fields.get(NativePasskeyStorage.PASSKEY_INDEX_FIELD) as string);
        expect(merged.map((item) => item.credentialId).sort()).toEqual(['cred-a', 'cred-b']);
    });

    test('does nothing when neither side has a passkey index', () => {
        const db = createDb();
        const target = entry(db, {});
        const source = entry(db, {});
        mergeNativePasskeyIndex(target, source);
        expect(target.fields.has(NativePasskeyStorage.PASSKEY_INDEX_FIELD)).toBe(false);
    });
});

describe('mergeKeepassxcPasskeyFields', () => {
    let privateKeyPem: string;

    beforeAll(async () => {
        const keyPair = await WebauthnCrypto.generateP256KeyPair();
        const pkcs8 = await WebauthnCrypto.exportPkcs8(keyPair.privateKey);
        privateKeyPem = WebauthnCrypto.pkcs8ToPem(pkcs8);
    });

    function withKeepassxcPasskey(db: Kdbx, credentialIdByte: number): KdbxEntry {
        const e = entry(db, {});
        e.fields.set('KPEX_PASSKEY_RELYING_PARTY', 'example.com');
        e.fields.set('KPEX_PASSKEY_USERNAME', 'alice');
        e.fields.set('KPEX_PASSKEY_USER_HANDLE', ProtectedValue.fromString('dXNlci1oYW5kbGU='));
        e.fields.set('KPEX_PASSKEY_CREDENTIAL_ID', ProtectedValue.fromString(Buffer.from([credentialIdByte]).toString('base64')));
        e.fields.set('KPEX_PASSKEY_PRIVATE_KEY_PEM', ProtectedValue.fromString(privateKeyPem));
        return e;
    }

    test('copies the whole passkey field set onto a target that has none', () => {
        const db = createDb();
        const target = entry(db, {});
        const source = withKeepassxcPasskey(db, 1);

        mergeKeepassxcPasskeyFields(target, source, false);

        expect(KeepassxcPasskeyStorage.readKeepassxcRecord(entryFieldsAsTextFor(target))).toBeDefined();
    });

    test('keeps the target set untouched when it already has one and preferSecondary is false', () => {
        const db = createDb();
        const target = withKeepassxcPasskey(db, 1);
        const source = withKeepassxcPasskey(db, 2);

        mergeKeepassxcPasskeyFields(target, source, false);

        const record = KeepassxcPasskeyStorage.readKeepassxcRecord(entryFieldsAsTextFor(target));
        expect(record?.credentialId[0]).toBe(1);
    });

    test('replaces the target set atomically when preferSecondary is true — never a field-by-field mix', () => {
        const db = createDb();
        const target = withKeepassxcPasskey(db, 1);
        const source = withKeepassxcPasskey(db, 2);

        mergeKeepassxcPasskeyFields(target, source, true);

        const record = KeepassxcPasskeyStorage.readKeepassxcRecord(entryFieldsAsTextFor(target));
        expect(record?.credentialId[0]).toBe(2);
    });

    function entryFieldsAsTextFor(e: KdbxEntry): Map<string, string> {
        const result = new Map<string, string>();
        for (const [name, value] of e.fields) {
            result.set(name, typeof value === 'string' ? value : value.getText());
        }
        return result;
    }
});
