import { describe, expect, test } from 'vitest';
import { faviconOrigin } from '../../src/background/favicon';

describe('faviconOrigin', () => {
    test('uses HTTPS for a bare domain', () => {
        expect(faviconOrigin('pinterest.com')).toBe('https://pinterest.com');
    });

    test('preserves a standard HTTP(S) origin', () => {
        expect(faviconOrigin('https://www.example.com/login?next=/home')).toBe('https://www.example.com');
    });

    test('chooses the first hostname alternative in a regex-style URL', () => {
        expect(faviconOrigin('(drive|photos|mail).google.com')).toBe('https://drive.google.com');
    });

    test('supports anchored and escaped regex-style hostnames', () => {
        expect(faviconOrigin('^(drive|photos|mail)\\.google\\.com$')).toBe('https://drive.google.com');
    });

    test('rejects values that cannot resolve to an HTTP(S) origin', () => {
        expect(() => faviconOrigin('not a URL')).toThrow('entry has no valid URL');
        expect(() => faviconOrigin('mailto:person@example.com')).toThrow('entry has no valid URL');
    });
});
