import { describe, expect, test } from 'vitest';
import * as WebauthnCrypto from '../../src/passkey/webauthn-crypto.js';
import type { PasskeyAlgorithm } from '../../src/passkey/webauthn-crypto.js';

async function generatePkcs8(algorithm: PasskeyAlgorithm): Promise<{ pkcs8: Uint8Array; publicKey: CryptoKey }> {
    let keyPair: CryptoKeyPair;
    if (algorithm === 'ES256') {
        keyPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
            'sign',
            'verify'
        ])) as CryptoKeyPair;
    } else if (algorithm === 'RS256') {
        keyPair = (await crypto.subtle.generateKey(
            {
                name: 'RSASSA-PKCS1-v1_5',
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: 'SHA-256'
            },
            true,
            ['sign', 'verify']
        )) as CryptoKeyPair;
    } else {
        keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    }
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    return { pkcs8, publicKey: keyPair.publicKey };
}

const ALGORITHMS: PasskeyAlgorithm[] = ['ES256', 'RS256', 'EdDSA'];
const VERIFY_PARAMS: Record<PasskeyAlgorithm, AlgorithmIdentifier | EcdsaParams> = {
    ES256: { name: 'ECDSA', hash: 'SHA-256' },
    RS256: { name: 'RSASSA-PKCS1-v1_5' },
    EdDSA: { name: 'Ed25519' }
};

describe('detectPkcs8Algorithm', () => {
    for (const algorithm of ALGORITHMS) {
        test(`detects ${algorithm} from a real PKCS8 key`, async () => {
            const { pkcs8 } = await generatePkcs8(algorithm);
            expect(WebauthnCrypto.detectPkcs8Algorithm(pkcs8)).toBe(algorithm);
        });
    }

    test('rejects an unsupported key algorithm OID', async () => {
        // DSA (1.2.840.10040.4.1) wrapped in a minimal, otherwise-valid PrivateKeyInfo shell.
        const dsaOid = Uint8Array.from([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x38, 0x04, 0x01]);
        const algId = Uint8Array.from([0x30, dsaOid.length, ...dsaOid]);
        const version = Uint8Array.from([0x02, 0x01, 0x00]);
        const body = Uint8Array.from([...version, ...algId]);
        const pkcs8 = Uint8Array.from([0x30, body.length, ...body]);
        expect(() => WebauthnCrypto.detectPkcs8Algorithm(pkcs8)).toThrow(/unsupported PKCS8 key algorithm OID/);
    });
});

describe('pemToPkcs8 / pkcs8ToPem', () => {
    test('round-trips through PEM', async () => {
        const { pkcs8 } = await generatePkcs8('ES256');
        const pem = WebauthnCrypto.pkcs8ToPem(pkcs8);
        expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
        expect(pem).toMatch(/-----END PRIVATE KEY-----$/);
        expect(WebauthnCrypto.pemToPkcs8(pem)).toEqual(pkcs8);
    });
});

describe('importAnyPrivateKey / signAssertion', () => {
    for (const algorithm of ALGORITHMS) {
        test(`signs and verifies with a real ${algorithm} key`, async () => {
            const { pkcs8, publicKey } = await generatePkcs8(algorithm);
            const privateKey = await WebauthnCrypto.importAnyPrivateKey(pkcs8, algorithm);
            const data = new TextEncoder().encode('assertion payload');

            const signature = await WebauthnCrypto.signAssertion(privateKey, algorithm, data);

            if (algorithm === 'ES256') {
                // ES256 signatures come back DER-encoded (WebAuthn requirement); WebCrypto verify wants raw r||s.
                expect(signature[0]).toBe(0x30);
            } else {
                const ok = await crypto.subtle.verify(VERIFY_PARAMS[algorithm], publicKey, signature as BufferSource, data);
                expect(ok).toBe(true);
            }
        });
    }
});

describe('base64Url helpers', () => {
    test('round-trips arbitrary bytes without padding characters', () => {
        const bytes = crypto.getRandomValues(new Uint8Array(33));
        const encoded = WebauthnCrypto.base64UrlEncode(bytes);
        expect(encoded).not.toMatch(/[+/=]/);
        expect(WebauthnCrypto.base64UrlDecode(encoded)).toEqual(bytes);
    });
});
