import { VaultEntryRecord } from './types.js';

// Generic CSV + KeePass format; one header-synonym table covers both formats.
const HEADER_SYNONYMS: Record<keyof Omit<VaultEntryRecord, 'tags' | 'icon'>, string[]> = {
    title: ['title', 'name', 'account', 'accountname'],
    username: ['username', 'user name', 'user', 'login', 'loginname', 'login name', 'email'],
    password: ['password', 'pass'],
    url: ['url', 'website', 'web site', 'login uri', 'uri', 'address'],
    notes: ['notes', 'note', 'comment', 'comments', 'extra'],
    group: ['group', 'folder'],
    totpSecret: ['totp', 'otp', 'otpauth', 'totp seed', 'one time password', 'one-time password']
};

function normalizeHeader(header: string): string {
    return header.trim().toLowerCase();
}

function matchColumn(header: string): keyof Omit<VaultEntryRecord, 'tags' | 'icon'> | 'tags' | undefined {
    const normalized = normalizeHeader(header);
    if (normalized === 'tags' || normalized === 'keywords') {
        return 'tags';
    }
    for (const [field, synonyms] of Object.entries(HEADER_SYNONYMS)) {
        if (synonyms.includes(normalized)) {
            return field as keyof Omit<VaultEntryRecord, 'tags' | 'icon'>;
        }
    }
    return undefined;
}

/** RFC 4180-ish tokenizer: quoted fields, "" escapes, commas/newlines inside quotes. */
function parseRows(text: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const len = text.length;

    const endField = () => {
        row.push(field);
        field = '';
    };
    const endRow = () => {
        endField();
        rows.push(row);
        row = [];
    };

    while (i < len) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i++;
                continue;
            }
            field += ch;
            i++;
            continue;
        }
        if (ch === '"') {
            inQuotes = true;
            i++;
            continue;
        }
        if (ch === ',') {
            endField();
            i++;
            continue;
        }
        if (ch === '\r') {
            i++;
            continue;
        }
        if (ch === '\n') {
            endRow();
            i++;
            continue;
        }
        field += ch;
        i++;
    }
    if (field.length > 0 || row.length > 0) {
        endRow();
    }
    return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

export function parseCsv(text: string): VaultEntryRecord[] {
    const rows = parseRows(text);
    if (rows.length === 0) {
        return [];
    }
    const [headerRow, ...dataRows] = rows;
    const columns = headerRow.map(matchColumn);
    if (!columns.some((c) => c === 'title' || c === 'username' || c === 'password')) {
        throw new Error('CSV has no recognizable title/username/password column');
    }

    return dataRows.map((row) => {
        const record: VaultEntryRecord = { title: '', username: '', password: '', url: '', notes: '' };
        columns.forEach((column, index) => {
            const value = row[index]?.trim();
            if (!column || !value) {
                return;
            }
            if (column === 'tags') {
                record.tags = value.split(/[;,]/).map((t) => t.trim()).filter(Boolean);
            } else {
                record[column] = value;
            }
        });
        return record;
    });
}

function escapeCsvField(value: string): string {
    if (/[",\n\r]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
}

const EXPORT_COLUMNS: (keyof Omit<VaultEntryRecord, 'tags' | 'icon'>)[] = [
    'group',
    'title',
    'username',
    'password',
    'url',
    'notes',
    'totpSecret'
];
const EXPORT_HEADER = ['Group', 'Title', 'Username', 'Password', 'URL', 'Notes', 'TOTP'];

export function exportToCsv(entries: VaultEntryRecord[]): string {
    const lines = [EXPORT_HEADER.join(',')];
    for (const entry of entries) {
        const row = EXPORT_COLUMNS.map((column) => escapeCsvField(entry[column] ?? ''));
        lines.push(row.join(','));
    }
    return lines.join('\r\n');
}
