import { getDomain } from 'tldts';

// Domain matching logic (pure, testable); tiers: exact → hostname → base domain → title.
export type MatchTier = 1 | 2 | 3 | 4;

export interface MatchableEntry {
    uuid: string;
    title: string;
    /** Primary URL plus any KP2A_URL_* custom strings (§5.4) — all checked at every tier. */
    urls: string[];
}

export interface MatchResult {
    uuid: string;
    tier: MatchTier;
}

const TIERS: MatchTier[] = [1, 2, 3, 4];

/** Returns entries at the highest tier that has any matches (§5.4) — never a mix of tiers. */
export function matchEntries(entries: MatchableEntry[], tabUrl: string): MatchResult[] {
    for (const tier of TIERS) {
        const matches = entries.filter((entry) => matchesAtTier(entry, tier, tabUrl));
        if (matches.length > 0) {
            return matches.map((entry) => ({ uuid: entry.uuid, tier }));
        }
    }
    return [];
}

function matchesAtTier(entry: MatchableEntry, tier: MatchTier, tabUrl: string): boolean {
    switch (tier) {
        case 1:
            return entry.urls.some((url) => normalizeUrl(url) === normalizeUrl(tabUrl));
        case 2: {
            const tabHostname = hostnameOf(tabUrl);
            return !!tabHostname && entry.urls.some((url) => hostnameOf(url) === tabHostname);
        }
        case 3: {
            const tabDomain = getDomain(tabUrl);
            return !!tabDomain && entry.urls.some((url) => getDomain(url) === tabDomain);
        }
        case 4: {
            const tabHostname = hostnameOf(tabUrl);
            return !!tabHostname && entry.title.toLowerCase().includes(tabHostname.toLowerCase());
        }
    }
}

function normalizeUrl(url: string): string {
    return url.trim().toLowerCase().replace(/\/+$/, '');
}

function hostnameOf(url: string): string | undefined {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return undefined;
    }
}
