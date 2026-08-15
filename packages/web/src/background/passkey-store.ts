import { getDomain } from 'tldts';
import { matchEntries, type MatchableEntry } from '../autofill/matcher';
import { decodeCborMap, encodeCborMap, type CborMap } from '../passkey-provider/cbor';
import { base64UrlEncode } from '../passkey-provider/webauthn-crypto';

// Pure helpers for the passkey storage model: attachments hold the credential, one plain
// custom field (KP_Passkey_Index) lets rpId lookups skip decrypting every attachment.

export interface PasskeyRecord {
    version: number;
    credentialId: Uint8Array;
    privateKeyPkcs8: Uint8Array;
    userHandle: Uint8Array;
    algorithm: number;
    rpId: string;
    signCount: number;
}

export interface PasskeyIndexEntry {
    credentialId: string; // base64url
    rpId: string;
}

const PASSKEY_ATTACHMENT_SUFFIX = '.keetar-passkey.cbor';
export const PASSKEY_INDEX_FIELD = 'KP_Passkey_Index';
const PASSKEY_RECORD_VERSION = 1;

export function passkeyAttachmentName(credentialId: Uint8Array): string {
    return `${base64UrlEncode(credentialId)}${PASSKEY_ATTACHMENT_SUFFIX}`;
}

export function isPasskeyAttachmentName(name: string): boolean {
    return name.endsWith(PASSKEY_ATTACHMENT_SUFFIX);
}

export function encodePasskeyRecord(record: Omit<PasskeyRecord, 'version'>): Uint8Array {
    const map: CborMap = new Map();
    map.set('v', PASSKEY_RECORD_VERSION);
    map.set('cid', record.credentialId);
    map.set('pk', record.privateKeyPkcs8);
    map.set('uh', record.userHandle);
    map.set('alg', record.algorithm);
    map.set('rp', record.rpId);
    map.set('sc', record.signCount);
    return encodeCborMap(map);
}

export function decodePasskeyRecord(bytes: Uint8Array): PasskeyRecord {
    const map = decodeCborMap(bytes);
    const version = map.get('v');
    const credentialId = map.get('cid');
    const privateKeyPkcs8 = map.get('pk');
    const userHandle = map.get('uh');
    const algorithm = map.get('alg');
    const rpId = map.get('rp');
    const signCount = map.get('sc');
    if (
        typeof version !== 'number' ||
        !(credentialId instanceof Uint8Array) ||
        !(privateKeyPkcs8 instanceof Uint8Array) ||
        !(userHandle instanceof Uint8Array) ||
        typeof algorithm !== 'number' ||
        typeof rpId !== 'string' ||
        typeof signCount !== 'number'
    ) {
        throw new Error('malformed passkey attachment');
    }
    return { version, credentialId, privateKeyPkcs8, userHandle, algorithm, rpId, signCount };
}

function isPasskeyIndexEntry(value: unknown): value is PasskeyIndexEntry {
    const candidate = value as Partial<PasskeyIndexEntry> | null;
    return typeof candidate?.credentialId === 'string' && typeof candidate.rpId === 'string';
}

export function parsePasskeyIndex(raw: string): PasskeyIndexEntry[] {
    if (!raw) {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(isPasskeyIndexEntry) : [];
    } catch {
        return [];
    }
}

export function serializePasskeyIndex(entries: PasskeyIndexEntry[]): string {
    return JSON.stringify(entries);
}

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
