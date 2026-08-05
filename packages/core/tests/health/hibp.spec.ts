import { describe, expect, test, vi } from 'vitest';
import { checkPasswordBreach, createHibpClient } from '../../src/health/hibp.js';

describe('HIBP client', () => {
    test('sends only the SHA-1 prefix and matches a local suffix', async () => {
        const fetchFn = vi.fn(async (url: string) => {
            expect(url).toBe('https://api.pwnedpasswords.com/range/5BAA6');
            return new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:4663\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1');
        });

        await expect(checkPasswordBreach('password', fetchFn)).resolves.toBe(4663);
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    test('caches a fetched range for subsequent checks', async () => {
        const fetchFn = vi.fn(async () => new Response('1E4C9B93F3F0682250B6CF8331B7EE68FD8:4663'));
        const client = createHibpClient(fetchFn);

        await expect(client.checkPassword('password')).resolves.toBe(4663);
        await expect(client.checkPassword('password')).resolves.toBe(4663);
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    test('surfaces unsuccessful responses instead of treating them as clean', async () => {
        await expect(checkPasswordBreach('password', async () => new Response('', { status: 503 }))).rejects.toThrow(
            'HIBP request failed with status 503'
        );
    });
});