import * as ByteUtils from '../utils/byte-utils.js';
import { detectPkcs8Algorithm, pemToPkcs8, pkcs8ToPem } from './webauthn-crypto.js';
import type { PasskeyRecord } from './record.js';

// KeePassXC's own storage convention (verified against its EntryAttributes.cpp/BrowserService.cpp) —
// a second, fully-native backend alongside native-storage.ts's. One passkey per entry, no index.

const FIELD_RELYING_PARTY = 'KPEX_PASSKEY_RELYING_PARTY';
const FIELD_USERNAME = 'KPEX_PASSKEY_USERNAME';
const FIELD_USERNAME_LEGACY = 'KPXC_PASSKEY_USERNAME';
const FIELD_USER_HANDLE = 'KPEX_PASSKEY_USER_HANDLE';
const FIELD_CREDENTIAL_ID = 'KPEX_PASSKEY_CREDENTIAL_ID';
const FIELD_CREDENTIAL_ID_LEGACY = 'KPEX_PASSKEY_GENERATED_USER_ID';
const FIELD_PRIVATE_KEY_PEM = 'KPEX_PASSKEY_PRIVATE_KEY_PEM';
const FIELD_FLAG_BE = 'KPEX_PASSKEY_FLAG_BE';
const FIELD_FLAG_BS = 'KPEX_PASSKEY_FLAG_BS';
// Keetar's own addition, for sign-count tracking — KeePassXC ignores fields it doesn't recognize.
const FIELD_SIGN_COUNT = 'KEETAR_PASSKEY_SIGN_COUNT';

export const KEEPASSXC_PASSKEY_FIELD_NAMES = [
    FIELD_RELYING_PARTY,
    FIELD_USERNAME,
    FIELD_USERNAME_LEGACY,
    FIELD_USER_HANDLE,
    FIELD_CREDENTIAL_ID,
    FIELD_CREDENTIAL_ID_LEGACY,
    FIELD_PRIVATE_KEY_PEM,
    FIELD_FLAG_BE,
    FIELD_FLAG_BS,
    FIELD_SIGN_COUNT
] as const;

const FIELD_NAME_SET = new Set<string>(KEEPASSXC_PASSKEY_FIELD_NAMES);

export function isKeepassxcPasskeyFieldName(name: string): boolean {
    return FIELD_NAME_SET.has(name);
}

// Plain field-name -> decoded-text map in, matching the rest of core's feature modules (e.g. totp.ts).
// Malformed values (bad base64, unparsable PEM, unknown key algorithm) mean "not a valid passkey"
// rather than a thrown error — this data can come from hand-edited fields, not just KeePassXC itself.
export function readKeepassxcRecord(fields: Map<string, string>): PasskeyRecord | undefined {
    const rpId = fields.get(FIELD_RELYING_PARTY);
    const credentialIdBase64 = fields.get(FIELD_CREDENTIAL_ID) ?? fields.get(FIELD_CREDENTIAL_ID_LEGACY);
    const privateKeyPem = fields.get(FIELD_PRIVATE_KEY_PEM);
    if (!rpId || !credentialIdBase64 || !privateKeyPem) {
        return undefined;
    }
    try {
        const privateKeyPkcs8 = pemToPkcs8(privateKeyPem);
        const userHandleBase64 = fields.get(FIELD_USER_HANDLE);
        const signCountRaw = fields.get(FIELD_SIGN_COUNT);
        return {
            // Tolerant of both plain base64 (KeePassXC) and base64url (Strongbox writes this way).
            credentialId: ByteUtils.base64UrlToBytes(credentialIdBase64),
            privateKeyPkcs8,
            userHandle: userHandleBase64 ? ByteUtils.base64UrlToBytes(userHandleBase64) : new Uint8Array(0),
            algorithm: detectPkcs8Algorithm(privateKeyPkcs8),
            rpId,
            username: fields.get(FIELD_USERNAME) ?? fields.get(FIELD_USERNAME_LEGACY) ?? '',
            signCount: signCountRaw && /^\d+$/.test(signCountRaw) ? Number(signCountRaw) : 0
        };
    } catch {
        return undefined;
    }
}

export interface KeepassxcFieldWrite {
    name: string;
    value: string;
    protect: boolean;
}

// Only the fields Keetar owns and fully understands — FLAG_BE/_BS and the legacy aliases are
// never touched, so an entry Keetar signs against stays fully usable by KeePassXC afterward.
export function writeKeepassxcRecord(record: PasskeyRecord): KeepassxcFieldWrite[] {
    return [
        { name: FIELD_RELYING_PARTY, value: record.rpId, protect: false },
        { name: FIELD_USERNAME, value: record.username, protect: false },
        { name: FIELD_USER_HANDLE, value: ByteUtils.bytesToBase64(record.userHandle), protect: true },
        { name: FIELD_CREDENTIAL_ID, value: ByteUtils.bytesToBase64(record.credentialId), protect: true },
        { name: FIELD_PRIVATE_KEY_PEM, value: pkcs8ToPem(record.privateKeyPkcs8), protect: true },
        { name: FIELD_SIGN_COUNT, value: String(record.signCount), protect: false }
    ];
}
