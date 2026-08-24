import { decodeCborMap, encodeCborMap, type CborMap } from './cbor.js';
import * as ByteUtils from '../utils/byte-utils.js';
import type { PasskeyAlgorithm } from './webauthn-crypto.js';
import type { PasskeyRecord } from './record.js';

// Keetar's own storage convention: the credential lives in an encrypted binary attachment,
// with one plain custom field (KP_Passkey_Index) so rpId lookups skip decrypting every attachment.

export interface PasskeyIndexEntry {
    credentialId: string; // base64url
    rpId: string;
}

const PASSKEY_ATTACHMENT_SUFFIX = '.keetar-passkey.cbor';
export const PASSKEY_INDEX_FIELD = 'KP_Passkey_Index';

export function passkeyAttachmentName(credentialId: Uint8Array): string {
    return `${ByteUtils.bytesToBase64Url(credentialId)}${PASSKEY_ATTACHMENT_SUFFIX}`;
}

export function isPasskeyAttachmentName(name: string): boolean {
    return name.endsWith(PASSKEY_ATTACHMENT_SUFFIX);
}

function isPasskeyAlgorithm(value: unknown): value is PasskeyAlgorithm {
    return value === 'ES256' || value === 'RS256' || value === 'EdDSA';
}

// v1 stored the COSE alg id (-7) instead of a name — only value Keetar ever wrote, since it
// only ever generated ES256 keys.
function normalizeAlgorithm(value: unknown): PasskeyAlgorithm {
    if (value === -7) {
        return 'ES256';
    }
    if (isPasskeyAlgorithm(value)) {
        return value;
    }
    throw new Error('unsupported passkey algorithm in native record');
}

export function encodeNativeRecord(record: PasskeyRecord): Uint8Array {
    const map: CborMap = new Map();
    map.set('v', 2);
    map.set('cid', record.credentialId);
    map.set('pk', record.privateKeyPkcs8);
    map.set('uh', record.userHandle);
    map.set('alg', record.algorithm);
    map.set('rp', record.rpId);
    map.set('sc', record.signCount);
    return encodeCborMap(map);
}

export function decodeNativeRecord(bytes: Uint8Array): PasskeyRecord {
    const map = decodeCborMap(bytes);
    const credentialId = map.get('cid');
    const privateKeyPkcs8 = map.get('pk');
    const userHandle = map.get('uh');
    const rpId = map.get('rp');
    const signCount = map.get('sc');
    if (
        !(credentialId instanceof Uint8Array) ||
        !(privateKeyPkcs8 instanceof Uint8Array) ||
        !(userHandle instanceof Uint8Array) ||
        typeof rpId !== 'string' ||
        typeof signCount !== 'number'
    ) {
        throw new Error('malformed passkey attachment');
    }
    // Native storage doesn't track a per-credential username — the entry's own UserName field serves that role.
    return { credentialId, privateKeyPkcs8, userHandle, algorithm: normalizeAlgorithm(map.get('alg')), rpId, username: '', signCount };
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
