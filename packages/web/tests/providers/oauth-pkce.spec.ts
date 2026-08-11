import { describe, expect, test } from 'vitest';
import { generateCodeChallenge, generateCodeVerifier } from '../../src/providers/oauth-pkce';

const BASE64URL_CHARS = /^[A-Za-z0-9\-_]+$/;

describe('generateCodeVerifier', () => {
    test('produces a string within RFC 7636\'s 43-128 char range', () => {
        const verifier = generateCodeVerifier();
        expect(verifier.length).toBeGreaterThanOrEqual(43);
        expect(verifier.length).toBeLessThanOrEqual(128);
    });

    test('only contains the base64url charset, no padding', () => {
        const verifier = generateCodeVerifier();
        expect(verifier).toMatch(BASE64URL_CHARS);
        expect(verifier).not.toContain('=');
        expect(verifier).not.toContain('+');
        expect(verifier).not.toContain('/');
    });

    test('is different on every call', () => {
        const a = generateCodeVerifier();
        const b = generateCodeVerifier();
        expect(a).not.toBe(b);
    });
});

describe('generateCodeChallenge', () => {
    test('matches RFC 7636 Appendix B\'s known test vector', async () => {
        const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
        const challenge = await generateCodeChallenge(verifier);
        expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    });

    test('is deterministic for the same verifier', async () => {
        const verifier = generateCodeVerifier();
        const a = await generateCodeChallenge(verifier);
        const b = await generateCodeChallenge(verifier);
        expect(a).toBe(b);
    });

    test('differs for different verifiers', async () => {
        const a = await generateCodeChallenge(generateCodeVerifier());
        const b = await generateCodeChallenge(generateCodeVerifier());
        expect(a).not.toBe(b);
    });

    test('only contains the base64url charset, no padding', async () => {
        const challenge = await generateCodeChallenge(generateCodeVerifier());
        expect(challenge).toMatch(BASE64URL_CHARS);
        expect(challenge).not.toContain('=');
    });
});
