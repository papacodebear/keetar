import { describe, expect, test } from 'vitest';
import { generateTotpCode, parseTotp } from '../../src/totp/totp.js';

const vectors = [
    { algorithm: 'SHA1', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', expected: '94287082' },
    {
        algorithm: 'SHA256',
        secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA',
        expected: '46119246'
    },
    {
        algorithm: 'SHA512',
        secret:
            'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA',
        expected: '90693936'
    }
];

describe('TOTP', () => {
    for (const vector of vectors) {
        test(`matches the RFC 6238 ${vector.algorithm} vector`, async () => {
            const result = await generateTotpCode(
                `otpauth://totp/Example?secret=${vector.secret}&algorithm=${vector.algorithm}&digits=8`,
                59_000
            );
            expect(result).toEqual({ code: vector.expected, remainingSeconds: 1 });
        });
    }

    test('accepts an unformatted Base32 secret with standard defaults', async () => {
        const result = await generateTotpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000);
        expect(result.code).toBe('287082');
        expect(result.remainingSeconds).toBe(1);
    });

    test('parses compatible custom period and digit settings', () => {
        expect(parseTotp('otpauth://totp/Example?secret=JBSWY3DPEHPK3PXP&period=60&digits=7')).toEqual({
            secret: 'JBSWY3DPEHPK3PXP',
            algorithm: 'SHA1',
            digits: 7,
            period: 60
        });
    });

    test('rejects unsupported URLs and malformed secrets', () => {
        expect(() => parseTotp('otpauth://hotp/Example?secret=JBSWY3DPEHPK3PXP')).toThrow(
            'unsupported OTP type'
        );
        expect(() => parseTotp('otpauth://totp/Example?secret=not-base32!')).toThrow(
            'invalid TOTP secret'
        );
    });
});