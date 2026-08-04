import { describe, test, expect } from 'vitest';
import { ByteUtils, ChaCha20 } from '../../src';

describe('ChaCha20', () => {
    test('transforms data', () => {
        const key = new Uint8Array(32);
        const nonce = new Uint8Array(8);

        const chacha20 = new ChaCha20(key, nonce);
        expect(ByteUtils.bytesToHex(chacha20.getBytes(32))).toBe(
            '76b8e0ada0f13d90405d6ae55386bd28bdd219b8a08ded1aa836efcc8b770dc7'
        );
        expect(ByteUtils.bytesToHex(chacha20.getBytes(32))).toBe(
            'da41597c5157488d7724e03fb8d84a376a43b8f41518a11cc387b669b2ee6586'
        );
    });
});
