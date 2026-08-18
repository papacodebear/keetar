import { describe, test, expect } from 'vitest';
import { isRpIdValidForOrigin } from '../../src/background/passkey-store';

// Regression coverage for the boundary that stops one site from creating/asserting a passkey
// scoped to another site's rpId (§ Options item 10 — cross-site entry isolation).
describe('isRpIdValidForOrigin', () => {
    test('accepts an rpId equal to the origin host', () => {
        expect(isRpIdValidForOrigin('example.com', 'https://example.com')).toBe(true);
    });

    test('accepts an rpId that is a registrable parent of a subdomain origin', () => {
        expect(isRpIdValidForOrigin('example.com', 'https://accounts.example.com')).toBe(true);
    });

    test('rejects an unrelated origin', () => {
        expect(isRpIdValidForOrigin('example.com', 'https://evil.com')).toBe(false);
    });

    test('rejects a look-alike domain that merely contains the rpId as a substring', () => {
        expect(isRpIdValidForOrigin('example.com', 'https://notexample.com')).toBe(false);
        expect(isRpIdValidForOrigin('example.com', 'https://example.com.evil.com')).toBe(false);
    });

    test('rejects claiming a narrower rpId than the actual origin (subdomain cannot vouch for a sibling)', () => {
        expect(isRpIdValidForOrigin('accounts.example.com', 'https://mail.example.com')).toBe(false);
    });

    test('rejects a public suffix as rpId even when the origin technically ends with it', () => {
        expect(isRpIdValidForOrigin('co.uk', 'https://example.co.uk')).toBe(false);
        expect(isRpIdValidForOrigin('com', 'https://example.com')).toBe(false);
    });

    test('is case-insensitive', () => {
        expect(isRpIdValidForOrigin('Example.com', 'https://EXAMPLE.COM')).toBe(true);
    });

    test('rejects a malformed origin instead of throwing', () => {
        expect(isRpIdValidForOrigin('example.com', 'not-a-url')).toBe(false);
    });
});
