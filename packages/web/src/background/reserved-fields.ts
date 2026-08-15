// Field names with dedicated meaning elsewhere in the vault — never user-editable as a generic custom field.

const RESERVED_EXACT = new Set([
    'Title',
    'UserName',
    'Password',
    'URL',
    'Notes',
    'otp',
    'TOTP Seed',
    'KP_Passkey_Index'
]);

const KP2A_URL_FIELD = /^KP2A_URL_\d+$/i;

export function isReservedFieldName(name: string): boolean {
    return RESERVED_EXACT.has(name) || KP2A_URL_FIELD.test(name);
}
