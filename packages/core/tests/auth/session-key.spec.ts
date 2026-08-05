import { describe, test, expect } from 'vitest';
import { wrapKeyMaterial, unwrapKeyMaterial } from '../../src/auth/session-key';
import { ByteUtils, CryptoEngine } from '../../src';

describe('session-key (AES-KW wrap/unwrap)', () => {
    test('round-trips 32-byte key material (a SHA-256 hash, the real use case)', async () => {
        const data = CryptoEngine.random(32);
        const vuk = CryptoEngine.random(32);

        const wrapped = await wrapKeyMaterial(data, vuk);
        expect(wrapped.byteLength).toBe(40); // AES-KW adds a fixed 8-byte integrity check value

        const unwrapped = await unwrapKeyMaterial(wrapped, vuk, 32);
        expect(ByteUtils.bytesToHex(unwrapped)).toBe(ByteUtils.bytesToHex(data));
    });

    test('unwrapping with the wrong VUK fails rather than returning garbage', async () => {
        const data = CryptoEngine.random(32);
        const vuk = CryptoEngine.random(32);
        const wrongVuk = CryptoEngine.random(32);

        const wrapped = await wrapKeyMaterial(data, vuk);
        await expect(unwrapKeyMaterial(wrapped, wrongVuk, 32)).rejects.toThrow();
    });

    test('unwrapping tampered wrapped data fails (AES-KW is authenticated)', async () => {
        const data = CryptoEngine.random(32);
        const vuk = CryptoEngine.random(32);

        const wrapped = await wrapKeyMaterial(data, vuk);
        const tampered = new Uint8Array(wrapped);
        tampered[0] ^= 0xff;

        await expect(unwrapKeyMaterial(tampered.buffer, vuk, 32)).rejects.toThrow();
    });

    test('different VUKs produce different wrapped output for the same data', async () => {
        const data = CryptoEngine.random(32);
        const vukA = CryptoEngine.random(32);
        const vukB = CryptoEngine.random(32);

        const wrappedA = await wrapKeyMaterial(data, vukA);
        const wrappedB = await wrapKeyMaterial(data, vukB);
        expect(ByteUtils.bytesToHex(wrappedA)).not.toBe(ByteUtils.bytesToHex(wrappedB));
    });
});
