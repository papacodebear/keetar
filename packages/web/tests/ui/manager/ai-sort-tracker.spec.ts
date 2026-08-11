import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// storage wraps chrome.storage.local — stub it directly rather than the platform module,
// since which browser file gets loaded is a build-time concern, not a test concern here.
// vi.mock factories aren't re-run by resetModules, so the backing map is cleared explicitly per test.
const backing = new Map<string, unknown>();
vi.mock('../../../src/platform', () => ({
    storage: {
        get: vi.fn(async (key: string) => backing.get(key)),
        set: vi.fn(async (key: string, value: unknown) => {
            backing.set(key, value);
        }),
        remove: vi.fn(async (key: string) => {
            backing.delete(key);
        })
    }
}));

beforeEach(() => {
    vi.resetModules();
    backing.clear();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('ai-sort-tracker', () => {
    test('starts empty for a vault that has never been sorted', async () => {
        const { getSortedEntryUuids } = await import('../../../src/ui/manager/ai-sort-tracker');
        expect(await getSortedEntryUuids('vault-a')).toEqual(new Set());
    });

    test('marking entries sorted persists them, additively across calls', async () => {
        const { getSortedEntryUuids, markEntriesSorted } = await import('../../../src/ui/manager/ai-sort-tracker');
        await markEntriesSorted('vault-a', ['e1', 'e2']);
        expect(await getSortedEntryUuids('vault-a')).toEqual(new Set(['e1', 'e2']));

        await markEntriesSorted('vault-a', ['e2', 'e3']);
        expect(await getSortedEntryUuids('vault-a')).toEqual(new Set(['e1', 'e2', 'e3']));
    });

    test('is scoped per vault', async () => {
        const { getSortedEntryUuids, markEntriesSorted } = await import('../../../src/ui/manager/ai-sort-tracker');
        await markEntriesSorted('vault-a', ['e1']);
        expect(await getSortedEntryUuids('vault-b')).toEqual(new Set());
    });

    test('marking an empty list is a no-op', async () => {
        const { getSortedEntryUuids, markEntriesSorted } = await import('../../../src/ui/manager/ai-sort-tracker');
        const platform = await import('../../../src/platform');
        await markEntriesSorted('vault-a', []);
        expect(platform.storage.set).not.toHaveBeenCalled();
        expect(await getSortedEntryUuids('vault-a')).toEqual(new Set());
    });
});
