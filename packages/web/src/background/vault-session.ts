import {
    analysePasswordHealth,
    ByteUtils,
    createHibpClient,
    Kdbx,
    KdbxCredentials,
    KdbxBinaries,
    ProtectedValue,
    Totp
} from '@keetar/core';
import type {
    KdbxBinary,
    KdbxBinaryWithHash,
    KdbxEntry,
    KdbxEntryField,
    KdbxGroup,
    KdbxMemoryProtection,
    PasswordHealthReport
} from '@keetar/core';
import { LocalFileProvider } from '../providers/local-file';

// In-memory decrypted vault state + lock logic (§3.4). Lives only in service
// worker module-level memory — lost on lock, lost on SW termination (both
// correct and expected per §3.4).

export interface VaultSummary {
    rootGroupName: string;
    entryCount: number;
    entryTitles: string[];
}

export interface EntrySummary {
    uuid: string;
    title: string;
    username: string;
    /** Primary URL plus any KP2A_URL_* custom strings (§5.4) — fed straight into autofill/matcher.ts. */
    urls: string[];
    hasTotp: boolean;
}

export type EntryFieldName = 'username' | 'password';

export interface EntryFields {
    title?: string;
    username?: string;
    password?: string;
    url?: string;
    notes?: string;
}

export interface AttachmentSummary {
    name: string;
    size: number;
}

export interface EntryDetail {
    uuid: string;
    groupUuid: string;
    title: string;
    username: string;
    password: string;
    url: string;
    notes: string;
    attachments: AttachmentSummary[];
}

export interface GroupNode {
    uuid: string;
    name: string;
    groups: GroupNode[];
    entries: EntrySummary[];
}

export interface GroupSummary {
    uuid: string;
    name: string;
}

export type { PasswordHealthReport };

const FIELD_MAP: Record<keyof EntryFields, { kdbxName: string; protectionKey: keyof KdbxMemoryProtection }> = {
    title: { kdbxName: 'Title', protectionKey: 'title' },
    username: { kdbxName: 'UserName', protectionKey: 'userName' },
    password: { kdbxName: 'Password', protectionKey: 'password' },
    url: { kdbxName: 'URL', protectionKey: 'url' },
    notes: { kdbxName: 'Notes', protectionKey: 'notes' }
};

type VaultSessionState =
    | { status: 'locked' }
    | { status: 'unlocked'; uuid: string; db: Kdbx };

const MAX_SUMMARY_TITLES = 20;

class VaultSession {
    private state: VaultSessionState = { status: 'locked' };
    private readonly hibpClient = createHibpClient();

    get status(): VaultSessionState['status'] {
        return this.state.status;
    }

    async unlock(uuid: string, password: string): Promise<VaultSummary> {
        const credentials = new KdbxCredentials(ProtectedValue.fromString(password));
        return this.unlockWithCredentials(uuid, credentials);
    }

    // Biometric unlock (§6.2): Popup already did the WebAuthn ceremony and
    // unwrapped the stored password hash itself — this just finishes the
    // job with it. `KdbxCredentials(null)` skips hashing a (nonexistent)
    // live password, then `.passwordHash` — a public field `getHash()`
    // reads directly, never re-deriving from a password string — is set by
    // hand. Everything past that point is Kdbx.load()'s completely
    // unmodified normal path; the Argon2 KDF still runs in full.
    async unlockWithHash(uuid: string, passwordHash: ArrayBuffer): Promise<VaultSummary> {
        const credentials = new KdbxCredentials(null);
        await credentials.ready;
        credentials.passwordHash = ProtectedValue.fromBinary(passwordHash);
        return this.unlockWithCredentials(uuid, credentials);
    }

    private async unlockWithCredentials(uuid: string, credentials: KdbxCredentials): Promise<VaultSummary> {
        const provider = new LocalFileProvider(uuid);
        const data = await provider.read('');
        const db = await Kdbx.load(data, credentials);
        this.state = { status: 'unlocked', uuid, db };
        return summarize(db);
    }

    // On lock: overwrite the key buffer with zeros, then drop the reference
    // (§3.4). The composite/derived key itself is zeroed internally by
    // @keetar/core as soon as it's consumed (kdbx-format.ts's decrypt
    // pipeline), so there's no separate key buffer for this session to zero
    // here — dropping the Kdbx reference (which holds the decrypted tree,
    // itself made of ProtectedValue-wrapped fields per §11.1) is what's left
    // to do at this layer.
    lock(): void {
        this.state = { status: 'locked' };
    }

    // Lightweight list for Popup's entry list (§8.2 — "credential
    // search/selection"). Title + username only, never the password: Popup
    // fetches an individual field on demand (getEntryField) only at the
    // moment the user actually copies it, rather than holding every entry's
    // full field set in the popup's own memory/DOM at once.
    listEntries(): EntrySummary[] {
        const db = this.requireUnlocked();
        const recycleBinUuid = db.meta.recycleBinUuid;
        const results: EntrySummary[] = [];
        const walk = (group: KdbxGroup) => {
            if (recycleBinUuid && group.uuid.equals(recycleBinUuid)) {
                return;
            }
            for (const entry of group.entries) {
                results.push(summarizeEntry(entry));
            }
            for (const subGroup of group.groups) {
                walk(subGroup);
            }
        };
        walk(db.getDefaultGroup());
        return results;
    }

    getEntryField(entryUuid: string, field: EntryFieldName): string {
        const entry = this.requireEntry(entryUuid);
        const fieldName = field === 'username' ? 'UserName' : 'Password';
        return fieldText(entry.fields.get(fieldName));
    }

    getEntryTotp(entryUuid: string): Promise<Totp.TotpCode> {
        const entry = this.requireEntry(entryUuid);
        const value = fieldText(entry.fields.get('otp')) || fieldText(entry.fields.get('TOTP Seed'));
        if (!value) {
            throw new Error('entry has no TOTP secret');
        }
        return Totp.generateTotpCode(value);
    }

    getPasswordHealth(): Promise<PasswordHealthReport> {
        const db = this.requireUnlocked();
        const recycleBinUuid = db.meta.recycleBinUuid;
        const entries = Array.from(db.getDefaultGroup().allEntries())
            .filter((entry) => !recycleBinUuid || !isInGroup(entry, recycleBinUuid))
            .map((entry) => ({
                uuid: entry.uuid.id,
                title: fieldText(entry.fields.get('Title')),
                password: fieldText(entry.fields.get('Password')),
                lastModified: entry.times.lastModTime
            }));
        return analysePasswordHealth(entries, (password) => this.hibpClient.checkPassword(password));
    }

    // Full vault-content tree for Manager (§8.2 — "group tree management").
    // Recycle bin included here (unlike listEntries(), used by Popup/autofill
    // matching) — Manager is where the user actually manages it.
    getGroupTree(): GroupNode {
        const db = this.requireUnlocked();
        return toGroupNode(db.getDefaultGroup());
    }

    getEntryDetail(entryUuid: string): EntryDetail {
        const entry = this.requireEntry(entryUuid);
        if (!entry.parentGroup) {
            throw new Error('entry has no parent group');
        }
        return {
            uuid: entry.uuid.id,
            groupUuid: entry.parentGroup.uuid.id,
            title: fieldText(entry.fields.get('Title')),
            username: fieldText(entry.fields.get('UserName')),
            password: fieldText(entry.fields.get('Password')),
            url: fieldText(entry.fields.get('URL')),
            notes: fieldText(entry.fields.get('Notes')),
            attachments: Array.from(entry.binaries.entries()).map(([name, value]) => ({
                name,
                size: resolveBinary(value).byteLength
            }))
        };
    }

    // Write path (§3.3, §14). Auto-saves on every mutation rather than
    // requiring an explicit save action — see §14's "Auto-save behaviour"
    // for the reasoning.
    async createEntry(groupUuid: string, fields: EntryFields): Promise<EntrySummary> {
        const db = this.requireUnlocked();
        const group = this.requireGroup(groupUuid);
        const entry = db.createEntry(group);
        applyFields(db, entry, fields);
        await this.persist();
        return summarizeEntry(entry);
    }

    async updateEntry(entryUuid: string, fields: EntryFields): Promise<void> {
        const db = this.requireUnlocked();
        const entry = this.requireEntry(entryUuid);
        entry.pushHistory();
        applyFields(db, entry, fields);
        entry.times.update();
        await this.persist();
    }

    async deleteEntry(entryUuid: string): Promise<void> {
        const db = this.requireUnlocked();
        const entry = this.requireEntry(entryUuid);
        db.remove(entry);
        await this.persist();
    }

    async moveEntry(entryUuid: string, toGroupUuid: string): Promise<void> {
        const db = this.requireUnlocked();
        const entry = this.requireEntry(entryUuid);
        const toGroup = this.requireGroup(toGroupUuid);
        db.move(entry, toGroup);
        await this.persist();
    }

    async createGroup(parentGroupUuid: string, name: string): Promise<GroupSummary> {
        const db = this.requireUnlocked();
        const parent = this.requireGroup(parentGroupUuid);
        const group = db.createGroup(parent, name);
        await this.persist();
        return { uuid: group.uuid.id, name: group.name ?? '' };
    }

    async renameGroup(groupUuid: string, name: string): Promise<void> {
        const group = this.requireGroup(groupUuid);
        group.name = name;
        group.times.update();
        await this.persist();
    }

    async deleteGroup(groupUuid: string): Promise<void> {
        const db = this.requireUnlocked();
        const group = this.requireGroup(groupUuid);
        if (group === db.getDefaultGroup()) {
            throw new Error('cannot delete the root group');
        }
        db.remove(group);
        await this.persist();
    }

    // dataBase64 rather than ArrayBuffer: chrome.runtime.sendMessage's
    // documented contract is a JSON-ifiable payload, and ArrayBuffer isn't
    // one (it would serialize to "{}"). Base64 crosses that boundary safely;
    // @keetar/core's ByteUtils already has the codecs.
    async addAttachment(entryUuid: string, name: string, dataBase64: string): Promise<void> {
        const db = this.requireUnlocked();
        const entry = this.requireEntry(entryUuid);
        const data = ByteUtils.arrayToBuffer(ByteUtils.base64ToBytes(dataBase64));
        const binary = await db.createBinary(data);
        entry.binaries.set(name, binary);
        entry.times.update();
        await this.persist();
    }

    async removeAttachment(entryUuid: string, name: string): Promise<void> {
        const entry = this.requireEntry(entryUuid);
        entry.binaries.delete(name);
        entry.times.update();
        await this.persist();
    }

    getAttachmentBase64(entryUuid: string, name: string): string {
        const entry = this.requireEntry(entryUuid);
        const binary = entry.binaries.get(name);
        if (!binary) {
            throw new Error('attachment not found');
        }
        return ByteUtils.bytesToBase64(resolveBinary(binary));
    }

    // Serializes the *entire current tree*, not an incremental diff — so if
    // this throws (e.g. file permission lapsed), the in-memory edit above
    // still stands, and the very next mutation's save attempt naturally
    // retries writing everything, including this one. No separate retry
    // mechanism needed; the failure is surfaced as an error on the mutation
    // that triggered it, not silently deferred (§14).
    private async persist(): Promise<void> {
        if (this.state.status !== 'unlocked') {
            throw new Error('vault is locked');
        }
        const { uuid, db } = this.state;
        const data = await db.save();
        const provider = new LocalFileProvider(uuid);
        await provider.write('', data);
    }

    private requireUnlocked(): Kdbx {
        if (this.state.status !== 'unlocked') {
            throw new Error('vault is locked');
        }
        return this.state.db;
    }

    private requireEntry(entryUuid: string): KdbxEntry {
        const db = this.requireUnlocked();
        const entry = findEntry(db.getDefaultGroup(), entryUuid);
        if (!entry) {
            throw new Error('entry not found');
        }
        return entry;
    }

    private requireGroup(groupUuid: string): KdbxGroup {
        const db = this.requireUnlocked();
        const group = findGroup(db.getDefaultGroup(), groupUuid);
        if (!group) {
            throw new Error('group not found');
        }
        return group;
    }
}

function fieldText(field: KdbxEntryField | undefined): string {
    if (field === undefined) {
        return '';
    }
    return typeof field === 'string' ? field : field.getText();
}

function applyFields(db: Kdbx, entry: KdbxEntry, fields: EntryFields): void {
    const protection = db.meta.memoryProtection;
    for (const key of Object.keys(fields) as (keyof EntryFields)[]) {
        const value = fields[key];
        if (value === undefined) {
            continue;
        }
        const { kdbxName, protectionKey } = FIELD_MAP[key];
        entry.fields.set(kdbxName, protection[protectionKey] ? ProtectedValue.fromString(value) : value);
    }
}

function resolveBinary(binary: KdbxBinary | KdbxBinaryWithHash): ArrayBuffer {
    const value = KdbxBinaries.isKdbxBinaryWithHash(binary) ? binary.value : binary;
    return value instanceof ProtectedValue ? bytesToArrayBuffer(value.getBinary()) : value;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const KP2A_URL_FIELD = /^KP2A_URL_\d+$/i;

function entryUrls(entry: KdbxEntry): string[] {
    const urls: string[] = [];
    const primary = fieldText(entry.fields.get('URL'));
    if (primary) {
        urls.push(primary);
    }
    for (const [key, value] of entry.fields) {
        if (KP2A_URL_FIELD.test(key)) {
            const text = fieldText(value);
            if (text) {
                urls.push(text);
            }
        }
    }
    return urls;
}

function summarizeEntry(entry: KdbxEntry): EntrySummary {
    return {
        uuid: entry.uuid.id,
        title: fieldText(entry.fields.get('Title')),
        username: fieldText(entry.fields.get('UserName')),
        urls: entryUrls(entry),
        hasTotp: Boolean(fieldText(entry.fields.get('otp')) || fieldText(entry.fields.get('TOTP Seed')))
    };
}

function toGroupNode(group: KdbxGroup): GroupNode {
    return {
        uuid: group.uuid.id,
        name: group.name ?? '',
        groups: group.groups.map(toGroupNode),
        entries: group.entries.map(summarizeEntry)
    };
}

function findEntry(group: KdbxGroup, uuid: string): KdbxEntry | undefined {
    for (const entry of group.entries) {
        if (entry.uuid.id === uuid) {
            return entry;
        }
    }
    for (const subGroup of group.groups) {
        const found = findEntry(subGroup, uuid);
        if (found) {
            return found;
        }
    }
    return undefined;
}

function findGroup(group: KdbxGroup, uuid: string): KdbxGroup | undefined {
    if (group.uuid.id === uuid) {
        return group;
    }
    for (const subGroup of group.groups) {
        const found = findGroup(subGroup, uuid);
        if (found) {
            return found;
        }
    }
    return undefined;
}

function isInGroup(entry: KdbxEntry, groupUuid: Kdbx['meta']['recycleBinUuid']): boolean {
    for (let group = entry.parentGroup; group; group = group.parentGroup) {
        if (group.uuid.equals(groupUuid)) {
            return true;
        }
    }
    return false;
}

function summarize(db: Kdbx): VaultSummary {
    const root = db.getDefaultGroup();
    const titles: string[] = [];
    let entryCount = 0;
    for (const entry of root.allEntries()) {
        entryCount++;
        if (titles.length < MAX_SUMMARY_TITLES) {
            titles.push(fieldText(entry.fields.get('Title')));
        }
    }
    return {
        rootGroupName: root.name ?? '',
        entryCount,
        entryTitles: titles
    };
}

export const vaultSession = new VaultSession();
