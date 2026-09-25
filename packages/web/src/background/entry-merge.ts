import { KeepassxcPasskeyStorage, NativePasskeyStorage, WebauthnCrypto } from '@keetar/core';
import type { KdbxEntry, KdbxEntryField } from '@keetar/core';

// Combine-vaults field-level comparison/merge: compares and merges every field actually present
// on either entry, not a fixed list, so nothing new is ever silently dropped.

const CORE_FIELD_NAMES = new Set(['Title', 'UserName', 'Password', 'URL', 'Notes', 'otp', 'TOTP Seed']);

export function fieldText(field: KdbxEntryField | undefined): string {
    if (field === undefined) {
        return '';
    }
    return typeof field === 'string' ? field : field.getText();
}

export function entryFieldsAsText(entry: KdbxEntry): Map<string, string> {
    const result = new Map<string, string>();
    for (const [name, value] of entry.fields) {
        result.set(name, fieldText(value));
    }
    return result;
}

export interface PasskeyIdentity {
    credentialId: string; // base64url
    rpId: string;
}

/** Every passkey on an entry, from either storage backend, identified by credential ID alone. */
export function passkeysOnEntry(entry: KdbxEntry): PasskeyIdentity[] {
    const results: PasskeyIdentity[] = [];
    for (const item of NativePasskeyStorage.parsePasskeyIndex(
        fieldText(entry.fields.get(NativePasskeyStorage.PASSKEY_INDEX_FIELD))
    )) {
        results.push({ credentialId: item.credentialId, rpId: item.rpId });
    }
    const keepassxcRecord = KeepassxcPasskeyStorage.readKeepassxcRecord(entryFieldsAsText(entry));
    if (keepassxcRecord) {
        results.push({ credentialId: WebauthnCrypto.base64UrlEncode(keepassxcRecord.credentialId), rpId: keepassxcRecord.rpId });
    }
    return results;
}

function samePasskeys(a: KdbxEntry, b: KdbxEntry): boolean {
    const idsOf = (entry: KdbxEntry) => new Set(passkeysOnEntry(entry).map((p) => p.credentialId));
    const aIds = idsOf(a);
    const bIds = idsOf(b);
    return aIds.size === bIds.size && [...aIds].every((id) => bIds.has(id));
}

function entryTotpSecret(entry: KdbxEntry): string {
    return fieldText(entry.fields.get('otp')) || fieldText(entry.fields.get('TOTP Seed'));
}

const CORE_FIELD_LABELS: [string, string][] = [
    ['Title', 'title'],
    ['UserName', 'username'],
    ['Password', 'password'],
    ['URL', 'url'],
    ['Notes', 'notes']
];

function skippedFieldNames(): Set<string> {
    return new Set([...CORE_FIELD_NAMES, NativePasskeyStorage.PASSKEY_INDEX_FIELD, ...KeepassxcPasskeyStorage.KEEPASSXC_PASSKEY_FIELD_NAMES]);
}

/** Every field that differs between two entries — standard fields, custom fields, and passkeys alike. */
export function entryFieldDiff(a: KdbxEntry, b: KdbxEntry): string[] {
    const differing: string[] = [];
    for (const [kdbxName, label] of CORE_FIELD_LABELS) {
        if (fieldText(a.fields.get(kdbxName)) !== fieldText(b.fields.get(kdbxName))) {
            differing.push(label);
        }
    }
    if (entryTotpSecret(a) !== entryTotpSecret(b)) {
        differing.push('one-time code');
    }
    if (!samePasskeys(a, b)) {
        differing.push('passkey');
    }

    const aFields = entryFieldsAsText(a);
    const bFields = entryFieldsAsText(b);
    const skip = skippedFieldNames();
    for (const name of new Set([...aFields.keys(), ...bFields.keys()])) {
        if (skip.has(name)) {
            continue;
        }
        if ((aFields.get(name) ?? '') !== (bFields.get(name) ?? '')) {
            differing.push(name);
        }
    }
    return differing;
}

// Mirrors dedup.ts's mergeStringField rule, but returns the winning field object (not just its
// text) so a protected custom field stays protected after merge.
function mergedField(
    primary: KdbxEntryField | undefined,
    secondary: KdbxEntryField | undefined,
    preferSecondary: boolean
): KdbxEntryField | undefined {
    const primaryText = fieldText(primary);
    const secondaryText = fieldText(secondary);
    if (!secondaryText) {
        return primary;
    }
    if (!primaryText) {
        return secondary;
    }
    if (primaryText === secondaryText) {
        return primary;
    }
    return preferSecondary ? secondary : primary;
}

/** Additively merges every custom field (anything not core or passkey) — union of names, conflicts fall back to preferSecondary. */
export function mergeCustomFields(entry: KdbxEntry, sourceEntry: KdbxEntry, preferSecondary: boolean): void {
    const skip = skippedFieldNames();
    for (const name of new Set([...entry.fields.keys(), ...sourceEntry.fields.keys()])) {
        if (skip.has(name)) {
            continue;
        }
        const merged = mergedField(entry.fields.get(name), sourceEntry.fields.get(name), preferSecondary);
        if (merged !== undefined && fieldText(merged)) {
            entry.fields.set(name, merged);
        }
    }
}

/** Unions the native-backend passkey index so attachments copyAttachments() already added stay discoverable. */
export function mergeNativePasskeyIndex(entry: KdbxEntry, sourceEntry: KdbxEntry): void {
    const target = NativePasskeyStorage.parsePasskeyIndex(fieldText(entry.fields.get(NativePasskeyStorage.PASSKEY_INDEX_FIELD)));
    const byId = new Map(target.map((item) => [item.credentialId, item]));
    for (const item of NativePasskeyStorage.parsePasskeyIndex(
        fieldText(sourceEntry.fields.get(NativePasskeyStorage.PASSKEY_INDEX_FIELD))
    )) {
        byId.set(item.credentialId, item);
    }
    if (byId.size > 0) {
        entry.fields.set(NativePasskeyStorage.PASSKEY_INDEX_FIELD, NativePasskeyStorage.serializePasskeyIndex(Array.from(byId.values())));
    }
}

// KeePassXC stores one passkey as a fixed field set — copied atomically, never field-by-field,
// so two different credentials can't get Frankenstein-merged into one broken key pair.
export function mergeKeepassxcPasskeyFields(entry: KdbxEntry, sourceEntry: KdbxEntry, preferSecondary: boolean): void {
    const hasTarget = KeepassxcPasskeyStorage.readKeepassxcRecord(entryFieldsAsText(entry)) !== undefined;
    const hasSource = KeepassxcPasskeyStorage.readKeepassxcRecord(entryFieldsAsText(sourceEntry)) !== undefined;
    if (!hasSource || (hasTarget && !preferSecondary)) {
        return;
    }
    for (const name of KeepassxcPasskeyStorage.KEEPASSXC_PASSKEY_FIELD_NAMES) {
        const value = sourceEntry.fields.get(name);
        if (value !== undefined) {
            entry.fields.set(name, value);
        }
    }
}
