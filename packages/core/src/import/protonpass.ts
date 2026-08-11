import { VaultEntryRecord } from './types.js';

// Proton Pass JSON export format; defensive parsing for real-world exports.
interface ProtonPassLoginContent {
    username?: string;
    password?: string;
    urls?: string[];
    totpUri?: string;
}

interface ProtonPassMetadata {
    name?: string;
    note?: string;
}

interface ProtonPassItemData {
    type?: string;
    metadata?: ProtonPassMetadata;
    content?: ProtonPassLoginContent;
}

interface ProtonPassItem {
    data?: ProtonPassItemData;
}

interface ProtonPassVault {
    name?: string;
    items?: ProtonPassItem[];
}

interface ProtonPassExport {
    vaults?: Record<string, ProtonPassVault>;
}

export function parseProtonPassJson(text: string): VaultEntryRecord[] {
    const data = JSON.parse(text) as ProtonPassExport;
    const records: VaultEntryRecord[] = [];
    for (const vault of Object.values(data.vaults ?? {})) {
        const group = vault.name;
        for (const item of vault.items ?? []) {
            const itemData = item.data;
            if (!itemData) {
                continue;
            }
            const isLogin = itemData.type === 'login';
            records.push({
                title: itemData.metadata?.name ?? '',
                username: isLogin ? itemData.content?.username ?? '' : '',
                password: isLogin ? itemData.content?.password ?? '' : '',
                url: isLogin ? itemData.content?.urls?.[0] ?? '' : '',
                notes: itemData.metadata?.note ?? '',
                group,
                totpSecret: (isLogin && itemData.content?.totpUri) || undefined
            });
        }
    }
    return records;
}
