import { describe, expect, test } from 'vitest';
import { decodeCborMap, encodeCborMap, type CborMap } from '../../src/passkey/cbor.js';

describe('CBOR map round-trip', () => {
    test('round-trips ints, text, and byte strings, including large lengths', () => {
        const map: CborMap = new Map();
        map.set('n', 42);
        map.set('neg', -7);
        map.set('text', 'hello world');
        map.set('bytes', new Uint8Array([1, 2, 3, 250]));
        map.set('long', new Uint8Array(300).fill(9));

        const decoded = decodeCborMap(encodeCborMap(map));

        expect(decoded.get('n')).toBe(42);
        expect(decoded.get('neg')).toBe(-7);
        expect(decoded.get('text')).toBe('hello world');
        expect(decoded.get('bytes')).toEqual(new Uint8Array([1, 2, 3, 250]));
        expect(decoded.get('long')).toEqual(new Uint8Array(300).fill(9));
    });

    test('round-trips nested maps', () => {
        const inner: CborMap = new Map();
        inner.set('a', 1);
        const outer: CborMap = new Map();
        outer.set('nested', inner);

        const decoded = decodeCborMap(encodeCborMap(outer));
        expect(decoded.get('nested')).toEqual(inner);
    });
});
