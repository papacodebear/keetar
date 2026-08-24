import { describe, expect, test } from 'vitest';
import { encodeCborMap, type CborMap } from '../../src/passkey/cbor.js';
import {
    decodeNativeRecord,
    encodeNativeRecord,
    isPasskeyAttachmentName,
    parsePasskeyIndex,
    passkeyAttachmentName,
    serializePasskeyIndex
} from '../../src/passkey/native-storage.js';
import type { PasskeyRecord } from '../../src/passkey/record.js';

function sampleRecord(): PasskeyRecord {
    return {
        credentialId: new Uint8Array([1, 2, 3, 4]),
        privateKeyPkcs8: new Uint8Array([9, 9, 9]),
        userHandle: new Uint8Array([5, 6, 7]),
        algorithm: 'ES256',
        rpId: 'example.com',
        username: 'ignored for native storage',
        signCount: 3
    };
}

describe('native record encode/decode', () => {
    test('round-trips a record (username is not persisted — native storage has no per-credential username)', () => {
        const record = sampleRecord();
        const decoded = decodeNativeRecord(encodeNativeRecord(record));
        expect(decoded).toEqual({ ...record, username: '' });
    });

    test('reads a legacy v1 record that stored the COSE alg id (-7) instead of a name', () => {
        const map: CborMap = new Map();
        map.set('v', 1);
        map.set('cid', new Uint8Array([1]));
        map.set('pk', new Uint8Array([2]));
        map.set('uh', new Uint8Array([3]));
        map.set('alg', -7);
        map.set('rp', 'example.com');
        map.set('sc', 0);
        const decoded = decodeNativeRecord(encodeCborMap(map));
        expect(decoded.algorithm).toBe('ES256');
    });

    test('rejects a malformed attachment', () => {
        expect(() => decodeNativeRecord(new Uint8Array([0xa0]))).toThrow(/malformed passkey attachment/);
    });
});

describe('passkeyAttachmentName', () => {
    test('is recognized by isPasskeyAttachmentName and stable for the same credential id', () => {
        const name = passkeyAttachmentName(new Uint8Array([1, 2, 3]));
        expect(isPasskeyAttachmentName(name)).toBe(true);
        expect(passkeyAttachmentName(new Uint8Array([1, 2, 3]))).toBe(name);
    });

    test('does not treat an unrelated attachment name as a passkey attachment', () => {
        expect(isPasskeyAttachmentName('receipt.pdf')).toBe(false);
    });
});

describe('passkey index (de)serialization', () => {
    test('round-trips and drops malformed entries', () => {
        const entries = [{ credentialId: 'abc', rpId: 'example.com' }];
        expect(parsePasskeyIndex(serializePasskeyIndex(entries))).toEqual(entries);
        expect(parsePasskeyIndex('not json')).toEqual([]);
        expect(parsePasskeyIndex('')).toEqual([]);
        expect(parsePasskeyIndex(JSON.stringify([{ credentialId: 'abc' }]))).toEqual([]);
    });
});
