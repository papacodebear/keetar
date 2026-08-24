import { getDomain } from 'tldts';
import { matchEntries, type MatchableEntry } from '../autofill/matcher';

// Web-only passkey helpers: both depend on browser-extension concerns (autofill's URL-matching
// heuristics, and a public-suffix-list dependency) that don't belong in @keetar/core.

/** Entries whose stored URL(s) match `rpId` the same way autofill matches a page — exact-tier only, since WebAuthn rpId matching is exact, not fuzzy. */
export function matchEntriesForRpId(entries: MatchableEntry[], rpId: string): MatchableEntry[] {
    const matched = new Set(matchEntries(entries, `https://${rpId}`).map((m) => m.uuid));
    return entries.filter((entry) => matched.has(entry.uuid));
}

// WebAuthn's own rpId rule: origin's host must equal rpId or be a subdomain of it, and rpId itself must be a registrable domain, not a public suffix.
export function isRpIdValidForOrigin(rpId: string, origin: string): boolean {
    let hostname: string;
    try {
        hostname = new URL(origin).hostname.toLowerCase();
    } catch {
        return false;
    }
    const normalizedRpId = rpId.toLowerCase();
    if (hostname === normalizedRpId) {
        return true;
    }
    return hostname.endsWith(`.${normalizedRpId}`) && getDomain(normalizedRpId) === normalizedRpId;
}
