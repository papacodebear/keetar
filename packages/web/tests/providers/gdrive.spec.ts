import { beforeEach, describe, expect, test, vi } from 'vitest';

const launchWebAuthFlow = vi.fn();
const store = { record: undefined as Record<string, unknown> | undefined };

vi.mock('../../src/platform', () => ({
    identity: { getRedirectURL: () => 'https://redirect.example/', launchWebAuthFlow }
}));
vi.mock('../../src/providers/oauth-token-store', () => ({
    loadTokens: async () => store.record,
    saveTokens: async (_provider: string, record: Record<string, unknown>) => {
        store.record = record;
    },
    removeTokens: async () => {
        store.record = undefined;
    }
}));

const { DriveAuthError, getAccessToken } = await import('../../src/providers/gdrive');

function grantToken(): void {
    launchWebAuthFlow.mockImplementation(async ({ url }: { url: string }) => {
        const state = new URL(url).searchParams.get('state');
        return `https://redirect.example/#access_token=fresh&expires_in=3600&state=${state}`;
    });
}

describe('Google Drive silent re-auth', () => {
    beforeEach(() => {
        launchWebAuthFlow.mockReset();
        vi.stubGlobal('fetch', vi.fn());
        store.record = { accessToken: 'old', refreshToken: undefined, expiresAt: 0, accountEmail: 'sam@example.com' };
    });

    test('asks Google for no UI and targets the remembered account', async () => {
        grantToken();
        await expect(getAccessToken()).resolves.toBe('fresh');
        const [{ url, interactive }] = launchWebAuthFlow.mock.calls[0];
        const params = new URL(url).searchParams;
        expect(interactive).toBe(false);
        expect(params.get('prompt')).toBe('none');
        expect(params.get('login_hint')).toBe('sam@example.com');
        expect(store.record).toMatchObject({ accessToken: 'fresh', accountEmail: 'sam@example.com' });
    });

    test('learns the account for connections made before it was remembered', async () => {
        store.record = { accessToken: 'old', refreshToken: undefined, expiresAt: 0 };
        vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ user: { emailAddress: 'sam@example.com' } })));
        grantToken();
        await getAccessToken();
        expect(new URL(launchWebAuthFlow.mock.calls[0][0].url).searchParams.has('login_hint')).toBe(false);
        expect(store.record?.accountEmail).toBe('sam@example.com');
    });

    test('still refreshes when the account lookup fails', async () => {
        store.record = { accessToken: 'old', refreshToken: undefined, expiresAt: 0 };
        vi.mocked(fetch).mockRejectedValue(new Error('offline'));
        grantToken();
        await expect(getAccessToken()).resolves.toBe('fresh');
    });

    test('reports a failed silent flow as needing a reconnect', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        launchWebAuthFlow.mockRejectedValue(new Error('interaction_required'));
        await expect(getAccessToken()).rejects.toBeInstanceOf(DriveAuthError);
    });

    test('reuses an unexpired token without any auth flow', async () => {
        store.record = { accessToken: 'live', refreshToken: undefined, expiresAt: Date.now() + 3_600_000 };
        await expect(getAccessToken()).resolves.toBe('live');
        expect(launchWebAuthFlow).not.toHaveBeenCalled();
    });
});
