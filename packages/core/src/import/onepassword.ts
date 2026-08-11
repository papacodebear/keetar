import { strFromU8, unzipSync } from 'fflate';
import { VaultEntryRecord } from './types.js';

// 1Password 1PUX format: ZIP with "export.data" JSON; defensive parsing for real-world exports.
interface OnePuxLoginField {
    value?: string;
    designation?: string;
}

interface OnePuxItemDetails {
    loginFields?: OnePuxLoginField[];
    password?: string;
    notesPlain?: string;
}

interface OnePuxItemOverview {
    title?: string;
    url?: string;
    tags?: string[];
}

interface OnePuxItem {
    categoryUuid?: string;
    overview?: OnePuxItemOverview;
    details?: OnePuxItemDetails;
}

interface OnePuxVault {
    attrs?: { name?: string };
    items?: OnePuxItem[];
}

interface OnePuxAccount {
    vaults?: OnePuxVault[];
}

interface OnePuxExport {
    accounts?: OnePuxAccount[];
}

// Categories "001"/"005" are Login/Password; others fold into Notes.
const LOGIN_CATEGORIES = new Set(['001', '005']);

export function parseOnePux(data: ArrayBuffer | Uint8Array): VaultEntryRecord[] {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    const files = unzipSync(bytes);
    const exportDataFile = files['export.data'];
    if (!exportDataFile) {
        throw new Error('1PUX archive is missing export.data');
    }
    const exportData = JSON.parse(strFromU8(exportDataFile)) as OnePuxExport;

    const records: VaultEntryRecord[] = [];
    for (const account of exportData.accounts ?? []) {
        for (const vault of account.vaults ?? []) {
            const group = vault.attrs?.name;
            for (const item of vault.items ?? []) {
                records.push(toRecord(item, group));
            }
        }
    }
    return records;
}

function toRecord(item: OnePuxItem, group: string | undefined): VaultEntryRecord {
    const loginFields = item.details?.loginFields ?? [];
    const findField = (designation: string) =>
        loginFields.find((f) => f.designation === designation)?.value;

    const isLogin = item.categoryUuid !== undefined && LOGIN_CATEGORIES.has(item.categoryUuid);

    return {
        title: item.overview?.title ?? '',
        username: isLogin ? findField('username') ?? '' : '',
        password: isLogin ? findField('password') ?? item.details?.password ?? '' : '',
        url: item.overview?.url ?? '',
        notes: item.details?.notesPlain ?? '',
        group,
        tags: item.overview?.tags
    };
}
