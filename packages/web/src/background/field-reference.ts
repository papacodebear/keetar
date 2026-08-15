// KeePass's own field-reference syntax ({REF:<Field>@I:<UUID hex>}) — a native KDBX mechanism,
// not a Keetar invention, so a "cloned" entry's shared fields stay correct in other KeePass clients too.

export type ReferencedField = 'U' | 'P';

const FIELD_REF_PATTERN = /^\{REF:([TUPAN])@I:([0-9A-Fa-f]{32})\}$/;

export function buildFieldReference(field: ReferencedField, sourceUuidHex: string): string {
    return `{REF:${field}@I:${sourceUuidHex.toUpperCase()}}`;
}

export function parseFieldReference(value: string): { field: string; uuidHex: string } | undefined {
    const match = FIELD_REF_PATTERN.exec(value.trim());
    return match ? { field: match[1].toUpperCase(), uuidHex: match[2].toUpperCase() } : undefined;
}
