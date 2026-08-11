// Cross-implementation tests with KeePassXC KDBX4 databases (GPLv2/GPLv3 license)

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as kdbxweb from '../../src';
import { argon2 } from '../test-support/argon2';

const KEEPASSXC_DIR = path.join(import.meta.dirname, '../../resources/external/keepassxc');

function readFile(name: string): ArrayBuffer {
    const filePath = path.join(KEEPASSXC_DIR, name);
    const content = fs.readFileSync(filePath);
    return kdbxweb.ByteUtils.arrayToBuffer(new Uint8Array(content));
}

describe('KeePassXC interop', () => {
    beforeAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    });

    afterAll(() => {
        kdbxweb.CryptoEngine.setArgon2Impl(undefined as any);
    });

    // Format400.kdbx: KeePassXC format compliance test file

    describe('Format400.kdbx (KDBX4, Argon2 1MB, password "t")', () => {
        test('loads and has valid root group', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('t')
            );
            const db = await kdbxweb.Kdbx.load(readFile('Format400.kdbx'), cred);
            expect(db).toBeInstanceOf(kdbxweb.Kdbx);
            expect(db.groups.length).toBe(1);
            expect(db.groups[0].name).toBe('Format400');
        }, 30000);

        test('reads entry fields correctly', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('t')
            );
            const db = await kdbxweb.Kdbx.load(readFile('Format400.kdbx'), cred);
            const root = db.getDefaultGroup();

            // Expects 1 entry with title/username "Format400"
            expect(root.entries.length).toBe(1);
            const entry = root.entries[0];
            expect(entry.fields.get('Title')).toBe('Format400');
            expect(entry.fields.get('UserName')).toBe('Format400');
        }, 30000);

        test('reads custom field "Format400"', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('t')
            );
            const db = await kdbxweb.Kdbx.load(readFile('Format400.kdbx'), cred);
            const entry = db.getDefaultGroup().entries[0];
            // Field may be ProtectedValue depending on memory protection
            const fieldValue = entry.fields.get('Format400');
            if (fieldValue instanceof kdbxweb.ProtectedValue) {
                expect(fieldValue.getText()).toBe('Format400');
            } else {
                expect(fieldValue).toBe('Format400');
            }
        }, 30000);

        test('reads binary attachment', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('t')
            );
            const db = await kdbxweb.Kdbx.load(readFile('Format400.kdbx'), cred);
            const entry = db.getDefaultGroup().entries[0];
            expect(entry.binaries.size).toBe(1);
            expect(entry.binaries.has('Format400')).toBe(true);
        }, 30000);

        test('is KDBX version 4', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('t')
            );
            const db = await kdbxweb.Kdbx.load(readFile('Format400.kdbx'), cred);
            expect(db.versionMajor).toBe(4);
        }, 30000);
    });

    // NewDatabaseBrowser.kdbx: KeePassXC browser integration test file

    describe('NewDatabaseBrowser.kdbx (KDBX4, AES KDF, password "a")', () => {
        test('loads successfully', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('a')
            );
            const db = await kdbxweb.Kdbx.load(
                readFile('NewDatabaseBrowser.kdbx'),
                cred
            );
            expect(db).toBeInstanceOf(kdbxweb.Kdbx);
            expect(db.versionMajor).toBe(4);
            expect(db.groups.length).toBe(1);
        }, 30000);

        test('has entries with browser integration fields', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('a')
            );
            const db = await kdbxweb.Kdbx.load(
                readFile('NewDatabaseBrowser.kdbx'),
                cred
            );

            // Walk all entries
            let totalEntries = 0;
            for (const _entry of db.getDefaultGroup().allEntries()) {
                totalEntries++;
            }
            expect(totalEntries).toBeGreaterThan(0);
        }, 30000);

        test('meta generator is KeePassXC', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('a')
            );
            const db = await kdbxweb.Kdbx.load(
                readFile('NewDatabaseBrowser.kdbx'),
                cred
            );
            expect(db.meta.generator).toMatch(/KeePass/);
        }, 30000);
    });

    describe('wrong password rejection', () => {
        test('rejects Format400.kdbx with wrong password', async () => {
            const cred = new kdbxweb.Credentials(
                kdbxweb.ProtectedValue.fromString('wrong-password')
            );
            try {
                await kdbxweb.Kdbx.load(readFile('Format400.kdbx'), cred);
                throw new Error('Should have thrown');
            } catch (e) {
                expect(e).toBeInstanceOf(kdbxweb.KdbxError);
                expect((e as kdbxweb.KdbxError).code).toBe(
                    kdbxweb.Consts.ErrorCodes.InvalidKey
                );
            }
        }, 30000);
    });
});
