import { VaultEntryRecord } from './types.js';

// Bitwarden JSON export format; defensive parsing ignores unknown fields for real-world exports.
interface BitwardenUri {
    uri?: string;
}

interface BitwardenLogin {
    username?: string;
    password?: string;
    totp?: string;
    uris?: BitwardenUri[];
}

interface BitwardenField {
    name?: string;
    value?: string;
}

interface BitwardenItem {
    type?: number;
    name?: string;
    notes?: string;
    folderId?: string | null;
    login?: BitwardenLogin;
    fields?: BitwardenField[];
}

interface BitwardenFolder {
    id?: string;
    name?: string;
}

interface BitwardenExport {
    folders?: BitwardenFolder[];
    items?: BitwardenItem[];
}

const TYPE_LOGIN = 1;

export function parseBitwardenJson(text: string): VaultEntryRecord[] {
    const data = JSON.parse(text) as BitwardenExport;
    const folderNames = new Map<string, string>();
    for (const folder of data.folders ?? []) {
        if (folder.id && folder.name) {
            folderNames.set(folder.id, folder.name);
        }
    }

    const records: VaultEntryRecord[] = [];
    for (const item of data.items ?? []) {
        const group = item.folderId ? folderNames.get(item.folderId) : undefined;
        const notes = extraFieldsNotes(item);

        if (item.type === TYPE_LOGIN && item.login) {
            records.push({
                title: item.name ?? '',
                username: item.login.username ?? '',
                password: item.login.password ?? '',
                url: item.login.uris?.[0]?.uri ?? '',
                notes,
                group,
                totpSecret: item.login.totp || undefined
            });
        } else {
            // Non-login items fold their fields into Notes to avoid losing data.
            records.push({
                title: item.name ?? '',
                username: '',
                password: '',
                url: '',
                notes,
                group
            });
        }
    }
    return records;
}

function extraFieldsNotes(item: BitwardenItem): string {
    const parts: string[] = [];
    if (item.notes) {
        parts.push(item.notes);
    }
    for (const field of item.fields ?? []) {
        if (field.name && field.value) {
            parts.push(`${field.name}: ${field.value}`);
        }
    }
    return parts.join('\n');
}
