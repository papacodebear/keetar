import { describe, test, expect } from 'vitest';
import { matchEntries, type MatchableEntry } from '../../src/autofill/matcher';

// Table-driven per §10.2. Each case is a single entry (one URL, unless
// otherwise noted) matched against one tab URL, asserting the highest tier
// that fires (or no match at all).
interface Case {
    label: string;
    entryUrl: string;
    entryTitle?: string;
    tabUrl: string;
    expectedTier: 1 | 2 | 3 | 4 | null;
}

const cases: Case[] = [
    // --- Tier 1: exact URL (normalized: lowercase, strip trailing slash) ---
    { label: 'identical URL', entryUrl: 'https://accounts.google.com', tabUrl: 'https://accounts.google.com', expectedTier: 1 },
    { label: 'trailing slash normalized away', entryUrl: 'https://accounts.google.com/', tabUrl: 'https://accounts.google.com', expectedTier: 1 },
    { label: 'both with trailing slash', entryUrl: 'https://example.com/', tabUrl: 'https://example.com/', expectedTier: 1 },
    { label: 'case-insensitive host', entryUrl: 'https://Example.com', tabUrl: 'https://example.com', expectedTier: 1 },
    { label: 'identical URL with path', entryUrl: 'https://example.com/login', tabUrl: 'https://example.com/login', expectedTier: 1 },
    { label: 'identical URL with query string', entryUrl: 'https://example.com/login?x=1', tabUrl: 'https://example.com/login?x=1', expectedTier: 1 },

    // --- Tier 2: exact hostname, URL otherwise differs ---
    // Corrected from an earlier ARCHITECTURE.md draft, which mislabeled this
    // pair as tier 1 — see §10.2's note on this exact case.
    { label: 'same host, different path', entryUrl: 'https://accounts.google.com', tabUrl: 'https://accounts.google.com/login', expectedTier: 2 },
    { label: 'same host, different query', entryUrl: 'https://example.com/login', tabUrl: 'https://example.com/login?x=1', expectedTier: 2 },
    { label: 'same host, different protocol', entryUrl: 'http://example.com', tabUrl: 'https://example.com', expectedTier: 2 },
    { label: 'same host, tab has port entry does not', entryUrl: 'https://example.com', tabUrl: 'https://example.com:8443', expectedTier: 2 },
    { label: 'same host, different fragment', entryUrl: 'https://example.com/#a', tabUrl: 'https://example.com/#b', expectedTier: 2 },
    { label: 'hostname comparison is case-insensitive', entryUrl: 'https://EXAMPLE.com/a', tabUrl: 'https://example.com/b', expectedTier: 2 },

    // --- Tier 3: base domain match, hostname differs ---
    { label: 'sibling subdomains', entryUrl: 'https://accounts.google.com', tabUrl: 'https://mail.google.com', expectedTier: 3 },
    { label: 'bare domain vs. subdomain', entryUrl: 'https://google.com', tabUrl: 'https://mail.google.com', expectedTier: 3 },
    { label: 'subdomain vs. bare domain', entryUrl: 'https://mail.google.com', tabUrl: 'https://google.com', expectedTier: 3 },
    { label: 'www vs. bare domain', entryUrl: 'https://www.example.com', tabUrl: 'https://example.com', expectedTier: 3 },
    { label: 'compound TLD: co.uk subdomains', entryUrl: 'https://accounts.example.co.uk', tabUrl: 'https://mail.example.co.uk', expectedTier: 3 },
    { label: 'compound TLD: com.au subdomains', entryUrl: 'https://login.example.com.au', tabUrl: 'https://shop.example.com.au', expectedTier: 3 },
    { label: 'deep subdomain vs. bare domain', entryUrl: 'https://a.b.c.example.com', tabUrl: 'https://example.com', expectedTier: 3 },
    { label: 'same registrable name, different compound TLD', entryUrl: 'https://example.co.uk', tabUrl: 'https://example.co.nz', expectedTier: null },

    // --- Tier 4: title fallback ---
    { label: 'title contains tab hostname', entryUrl: 'https://internal.example.org', entryTitle: 'My mail.google.com bookmark', tabUrl: 'https://mail.google.com', expectedTier: 4 },
    { label: 'title match is case-insensitive', entryUrl: 'https://internal.example.org', entryTitle: 'MAIL.GOOGLE.COM', tabUrl: 'https://mail.google.com', expectedTier: 4 },

    // --- No match ---
    { label: 'unrelated domains', entryUrl: 'https://github.com', tabUrl: 'https://gitlab.com', expectedTier: null },
    { label: 'similar but distinct domains', entryUrl: 'https://example.com', tabUrl: 'https://example.net', expectedTier: null },
    { label: 'title does not mention hostname', entryUrl: 'https://internal.example.org', entryTitle: 'My banking site', tabUrl: 'https://unrelated.test', expectedTier: null },
    { label: 'empty entry URL', entryUrl: '', tabUrl: 'https://example.com', expectedTier: null },
    { label: 'malformed entry URL does not throw', entryUrl: 'not a url', tabUrl: 'https://example.com', expectedTier: null }
];

describe('matchEntries', () => {
    for (const c of cases) {
        test(`${c.label} → tier ${c.expectedTier ?? 'none'}`, () => {
            const entry: MatchableEntry = {
                uuid: 'entry-1',
                title: c.entryTitle ?? 'Untitled',
                urls: c.entryUrl ? [c.entryUrl] : []
            };
            const results = matchEntries([entry], c.tabUrl);
            if (c.expectedTier === null) {
                expect(results).toEqual([]);
            } else {
                expect(results).toEqual([{ uuid: 'entry-1', tier: c.expectedTier }]);
            }
        });
    }

    test('returns only the highest tier when multiple entries match at different tiers', () => {
        const exact: MatchableEntry = { uuid: 'exact', title: '', urls: ['https://example.com/login'] };
        const domainOnly: MatchableEntry = { uuid: 'domain-only', title: '', urls: ['https://other.example.com'] };
        const results = matchEntries([exact, domainOnly], 'https://example.com/login');
        expect(results).toEqual([{ uuid: 'exact', tier: 1 }]);
    });

    test('returns all entries tied at the winning tier', () => {
        const a: MatchableEntry = { uuid: 'a', title: '', urls: ['https://mail.example.com'] };
        const b: MatchableEntry = { uuid: 'b', title: '', urls: ['https://calendar.example.com'] };
        const results = matchEntries([a, b], 'https://drive.example.com');
        expect(results.sort((x, y) => x.uuid.localeCompare(y.uuid))).toEqual([
            { uuid: 'a', tier: 3 },
            { uuid: 'b', tier: 3 }
        ]);
    });

    test('checks every URL on an entry (KP2A_URL_* semantics), not just the first', () => {
        const entry: MatchableEntry = {
            uuid: 'multi',
            title: '',
            urls: ['https://primary.example.org', 'https://secondary.example.net']
        };
        const results = matchEntries([entry], 'https://secondary.example.net');
        expect(results).toEqual([{ uuid: 'multi', tier: 1 }]);
    });

    test('no entries, no matches', () => {
        expect(matchEntries([], 'https://example.com')).toEqual([]);
    });
});
