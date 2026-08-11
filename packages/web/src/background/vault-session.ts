import {
    analysePasswordHealth,
    ByteUtils,
    Consts,
    createHibpClient,
    exportToCsv,
    exportToXml,
    Kdbx,
    KdbxCredentials,
    KdbxBinaries,
    KdbxUuid,
    ProtectedValue,
    Totp
} from '@keetar/core';
import type {
    FileProvider,
    KdbxBinary,
    KdbxBinaryWithHash,
    KdbxEntry,
    KdbxEntryField,
    KdbxGroup,
    KdbxMemoryProtection,
    PasswordHealthReport,
    VaultEntryRecord
} from '@keetar/core';
import { getConfiguredVault } from '../config/vault-config';
import { createFileProvider } from '../providers';
import { fetchFaviconPng } from './favicon';
import {
    findDuplicateGroups,
    findNonConflicting,
    mergeIcon,
    mergeStringField,
    partitionByPasswordMatch
} from './dedup';
import type { DedupGroup, IdentifiedRecord } from './dedup';

// In-memory decrypted vault state, lost on lock or SW termination (§3.4).

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
    /** KeePass's built-in icon index (0-68, Consts.Icons) — a static asset lookup, not fetched. */
    icon: number;
    /** True when a custom icon image is set; fetched separately (getEntryCustomIconBase64) since it's binary. */
    hasCustomIcon: boolean;
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
    icon: number;
    hasCustomIcon: boolean;
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

export interface CombineConflictEntry {
    uuid: string;
    title: string;
    username: string;
    url: string;
}

export interface CombineConflict {
    key: string;
    primary: CombineConflictEntry[];
    secondary: CombineConflictEntry[];
}

export type CombineResolution = 'keep-a' | 'keep-b' | 'keep-both';

const FIELD_MAP: Record<keyof EntryFields, { kdbxName: string; protectionKey: keyof KdbxMemoryProtection }> = {
    title: { kdbxName: 'Title', protectionKey: 'title' },
    username: { kdbxName: 'UserName', protectionKey: 'userName' },
    password: { kdbxName: 'Password', protectionKey: 'password' },
    url: { kdbxName: 'URL', protectionKey: 'url' },
    notes: { kdbxName: 'Notes', protectionKey: 'notes' }
};

type VaultSessionState =
    | { status: 'locked' }
    | { status: 'unlocked'; uuid: string; db: Kdbx; provider: FileProvider; path: string };

const MAX_SUMMARY_TITLES = 20;
const FAVICON_FETCH_CONCURRENCY = 10;

class VaultSession {
    private state: VaultSessionState = { status: 'locked' };
    private readonly hibpClient = createHibpClient();
    private secondaryDb: Kdbx | undefined;
    private pendingCombine:
        | { identicalGroups: DedupGroup[]; divergentGroups: DedupGroup[]; nonConflicting: IdentifiedRecord[] }
        | undefined;

    get status(): VaultSessionState['status'] {
        return this.state.status;
    }

    async unlock(uuid: string, password: string): Promise<VaultSummary> {
        const credentials = new KdbxCredentials(ProtectedValue.fromString(password));
        return this.unlockWithCredentials(uuid, credentials);
    }

    // Biometric unlock (§6.2): finish WebAuthn by directly setting the pre-unwrapped password hash.
    async unlockWithHash(uuid: string, passwordHash: ArrayBuffer): Promise<VaultSummary> {
        const credentials = new KdbxCredentials(null);
        await credentials.ready;
        credentials.passwordHash = ProtectedValue.fromBinary(passwordHash);
        return this.unlockWithCredentials(uuid, credentials);
    }

    private async unlockWithCredentials(uuid: string, credentials: KdbxCredentials): Promise<VaultSummary> {
        const configured = await getConfiguredVault();
        if (!configured || configured.uuid !== uuid) {
            throw new Error('vault is not configured');
        }
        const provider = createFileProvider(configured);
        const path = configured.path ?? '';
        const data = await provider.read(path);
        const db = await Kdbx.load(data, credentials);
        this.state = { status: 'unlocked', uuid, db, provider, path };
        return summarize(db);
    }

    // On lock: drop the Kdbx reference to zero the decrypted tree (§3.4).
    lock(): void {
        this.state = { status: 'locked' };
    }

    // Lightweight list for Popup (§8.2): title+username only, password fetched on-demand per field.
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

    // Password matching happens here, in the background — passwords never leave for this (§8.2).
    searchEntries(query: string): EntrySummary[] {
        const db = this.requireUnlocked();
        const recycleBinUuid = db.meta.recycleBinUuid;
        const term = query.toLowerCase();
        const results: EntrySummary[] = [];
        const walk = (group: KdbxGroup) => {
            if (recycleBinUuid && group.uuid.equals(recycleBinUuid)) {
                return;
            }
            for (const entry of group.entries) {
                if (entryMatchesSearch(entry, term)) {
                    results.push(summarizeEntry(entry));
                }
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

    // Full vault tree for Manager (§8.2), including recycle bin.
    getGroupTree(): { root: GroupNode; recycleBinGroupUuid: string | undefined } {
        const db = this.requireUnlocked();
        return { root: toGroupNode(db.getDefaultGroup()), recycleBinGroupUuid: db.meta.recycleBinUuid?.id };
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
            })),
            icon: entry.icon ?? Consts.Icons.Key,
            hasCustomIcon: entry.customIcon !== undefined
        };
    }

    // Fetch custom icon on demand (binary data not in list responses).
    getEntryCustomIconBase64(entryUuid: string): string {
        const db = this.requireUnlocked();
        const entry = this.requireEntry(entryUuid);
        if (!entry.customIcon) {
            throw new Error('entry has no custom icon');
        }
        const customIcon = db.meta.customIcons.get(entry.customIcon.id);
        if (!customIcon) {
            throw new Error('custom icon data not found');
        }
        return ByteUtils.bytesToBase64(customIcon.data);
    }

    // Write path (§3.3, §14): auto-saves on every mutation.
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

    // AI-sort apply: one persist for the whole batch, not one per move (§8.2 — Drive vaults re-upload on every persist).
    async applyAiSort(assignments: { entryUuid: string; groupName: string }[]): Promise<{
        groupsCreated: number;
        entriesMoved: number;
        skipped: number;
    }> {
        const db = this.requireUnlocked();
        const recycleBinUuid = db.meta.recycleBinUuid;
        const root = db.getDefaultGroup();
        const groupsByName = new Map<string, KdbxGroup>();
        const collect = (group: KdbxGroup) => {
            if (recycleBinUuid && group.uuid.equals(recycleBinUuid)) {
                return;
            }
            groupsByName.set((group.name ?? '').toLowerCase(), group);
            for (const subGroup of group.groups) {
                collect(subGroup);
            }
        };
        collect(root);

        let groupsCreated = 0;
        let entriesMoved = 0;
        let skipped = 0;
        for (const { entryUuid, groupName } of assignments) {
            const entry = findEntry(root, entryUuid);
            if (!entry) {
                skipped++;
                continue;
            }
            const key = groupName.toLowerCase();
            let targetGroup = groupsByName.get(key);
            if (!targetGroup) {
                targetGroup = db.createGroup(root, groupName);
                groupsByName.set(key, targetGroup);
                groupsCreated++;
            }
            if (entry.parentGroup?.uuid.equals(targetGroup.uuid)) {
                skipped++;
                continue;
            }
            db.move(entry, targetGroup);
            entriesMoved++;
        }
        await this.persist();
        return { groupsCreated, entriesMoved, skipped };
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

    // Import (§9): resolve group paths, creating folders as needed to avoid duplication.
    async importEntries(groupUuid: string, records: VaultEntryRecord[]): Promise<{ imported: number }> {
        const db = this.requireUnlocked();
        const targetGroup = this.requireGroup(groupUuid);
        const groupCache = new Map<string, KdbxGroup>();
        for (const record of records) {
            const group = record.group
                ? resolveGroupPath(db, targetGroup, record.group, groupCache)
                : targetGroup;
            await createEntryFromRecord(db, group, record);
        }
        await this.persist();
        return { imported: records.length };
    }

    // Export (§9): walk tree excluding recycle bin, hand to format writers.
    exportVault(format: 'csv' | 'xml'): string {
        const db = this.requireUnlocked();
        const records = kdbxToRecords(db);
        return format === 'csv' ? exportToCsv(records) : exportToXml(records);
    }

    // Combine vaults: open secondary vault for merging (uses heuristic dedup, not object identity).
    async openSecondaryVault(data: ArrayBuffer, password: string): Promise<VaultSummary> {
        const credentials = new KdbxCredentials(ProtectedValue.fromString(password));
        const db = await Kdbx.load(data, credentials);
        this.secondaryDb = db;
        this.pendingCombine = undefined;
        return summarize(db);
    }

    closeSecondaryVault(): void {
        this.secondaryDb = undefined;
        this.pendingCombine = undefined;
    }

    // Compute conflict groups; auto-resolve identical 1:1 pairs (same password = unchanged entry).
    previewCombine(): { conflicts: CombineConflict[]; nonConflictingCount: number; identicalCount: number } {
        const db = this.requireUnlocked();
        if (!this.secondaryDb) {
            throw new Error('no secondary vault open');
        }
        const primaryRecords = kdbxToRecords(db);
        const secondaryRecords = kdbxToRecords(this.secondaryDb);
        const allGroups = findDuplicateGroups(primaryRecords, secondaryRecords);
        const { identical, divergent } = partitionByPasswordMatch(allGroups);
        const nonConflicting = findNonConflicting(secondaryRecords, allGroups);
        this.pendingCombine = { identicalGroups: identical, divergentGroups: divergent, nonConflicting };
        return {
            conflicts: divergent.map((group) => ({
                key: group.key,
                primary: group.primary.map(toConflictEntry),
                secondary: group.secondary.map(toConflictEntry)
            })),
            nonConflictingCount: nonConflicting.length,
            identicalCount: identical.length
        };
    }

    // Merge matched pairs field-by-field; 'keep-both' forking imports separately; ambiguous groups use whole-entry behavior.
    async applyCombine(
        groupUuid: string,
        resolutions: Record<string, CombineResolution>
    ): Promise<{ imported: number; merged: number; replaced: number }> {
        const db = this.requireUnlocked();
        const secondaryDb = this.secondaryDb;
        if (!secondaryDb || !this.pendingCombine) {
            throw new Error('call previewCombine first');
        }
        const targetGroup = this.requireGroup(groupUuid);
        const groupCache = new Map<string, KdbxGroup>();
        let imported = 0;
        let merged = 0;
        let replaced = 0;

        const importRecord = async (record: IdentifiedRecord) => {
            const group = record.group
                ? resolveGroupPath(db, targetGroup, record.group, groupCache)
                : targetGroup;
            const sourceEntry = findEntry(secondaryDb.getDefaultGroup(), record.uuid);
            await createEntryFromRecord(db, group, record, sourceEntry);
            imported++;
        };

        const mergeInto = async (
            primaryRecord: IdentifiedRecord,
            secondaryRecord: IdentifiedRecord,
            resolution: 'keep-a' | 'keep-b'
        ) => {
            const entry = findEntry(db.getDefaultGroup(), primaryRecord.uuid);
            const sourceEntry = findEntry(secondaryDb.getDefaultGroup(), secondaryRecord.uuid);
            if (entry && sourceEntry) {
                await mergeRecordIntoEntry(db, entry, secondaryRecord, resolution, sourceEntry);
                merged++;
            }
        };

        // Auto-resolved identical pairs: still merge non-password fields that may differ.
        for (const group of this.pendingCombine.identicalGroups) {
            await mergeInto(group.primary[0], group.secondary[0], 'keep-a');
        }

        for (const group of this.pendingCombine.divergentGroups) {
            const resolution = resolutions[group.key] ?? 'keep-a';
            const isCleanPair = group.primary.length === 1 && group.secondary.length === 1;

            if (resolution === 'keep-both') {
                for (const secondaryRecord of group.secondary) {
                    await importRecord(secondaryRecord);
                }
                continue;
            }
            if (isCleanPair) {
                await mergeInto(group.primary[0], group.secondary[0], resolution);
                continue;
            }
            // Ambiguous multiplicity: fall back to whole-entry replace-or-skip.
            if (resolution === 'keep-a') {
                continue;
            }
            for (const primaryRecord of group.primary) {
                const entry = findEntry(db.getDefaultGroup(), primaryRecord.uuid);
                if (entry) {
                    db.remove(entry);
                    replaced++;
                }
            }
            for (const secondaryRecord of group.secondary) {
                await importRecord(secondaryRecord);
            }
        }

        for (const record of this.pendingCombine.nonConflicting) {
            await importRecord(record);
        }

        await this.persist();
        this.closeSecondaryVault();
        return { imported, merged, replaced };
    }

    // On-demand favicon download as custom icon (§9 addendum); no dedup like binaries.
    async setCustomIconFromFavicon(entryUuid: string): Promise<void> {
        const db = this.requireUnlocked();
        const entry = this.requireEntry(entryUuid);
        await this.applyFaviconToEntry(db, entry);
        await this.persist();
    }

    // Bulk favicon fetch: concurrent per-entry fetches with per-entry error tolerance (§14).
    async fetchMissingFavicons(): Promise<{ updated: number; failed: number; skipped: number }> {
        const db = this.requireUnlocked();
        const recycleBinUuid = db.meta.recycleBinUuid;
        const candidates: KdbxEntry[] = [];
        let skipped = 0;
        for (const entry of db.getDefaultGroup().allEntries()) {
            if (recycleBinUuid && isInGroup(entry, recycleBinUuid)) {
                continue;
            }
            if (entry.customIcon || !fieldText(entry.fields.get('URL'))) {
                skipped++;
                continue;
            }
            candidates.push(entry);
        }

        let updated = 0;
        let failed = 0;
        await runWithConcurrency(candidates, FAVICON_FETCH_CONCURRENCY, async (entry) => {
            try {
                await this.applyFaviconToEntry(db, entry);
                updated++;
            } catch {
                failed++;
            }
        });

        if (updated > 0) {
            await this.persist();
        }
        return { updated, failed, skipped };
    }

    private async applyFaviconToEntry(db: Kdbx, entry: KdbxEntry): Promise<void> {
        const url = fieldText(entry.fields.get('URL'));
        if (!url) {
            throw new Error('entry has no URL to fetch a favicon from');
        }
        const pngData = await fetchFaviconPng(url);
        const iconUuid = KdbxUuid.random();
        db.meta.customIcons.set(iconUuid.id, { data: pngData, lastModified: new Date() });
        entry.customIcon = iconUuid;
        entry.times.update();
    }

    // Use dataBase64, not ArrayBuffer (JSON-ifiable payload requirement).
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

    // Serialize entire tree; failure surfaces as error on triggering mutation (§14).
    private async persist(): Promise<void> {
        if (this.state.status !== 'unlocked') {
            throw new Error('vault is locked');
        }
        const { db, provider, path } = this.state;
        const data = await db.save();
        await provider.write(path, data);
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

function kdbxToRecords(db: Kdbx): IdentifiedRecord[] {
    const recycleBinUuid = db.meta.recycleBinUuid;
    const records: IdentifiedRecord[] = [];
    const walk = (group: KdbxGroup, path: string[]) => {
        if (recycleBinUuid && group.uuid.equals(recycleBinUuid)) {
            return;
        }
        for (const entry of group.entries) {
            records.push({
                uuid: entry.uuid.id,
                title: fieldText(entry.fields.get('Title')),
                username: fieldText(entry.fields.get('UserName')),
                password: fieldText(entry.fields.get('Password')),
                url: fieldText(entry.fields.get('URL')),
                notes: fieldText(entry.fields.get('Notes')),
                group: path.length ? path.join('/') : undefined,
                tags: entry.tags.length ? entry.tags : undefined,
                totpSecret:
                    fieldText(entry.fields.get('otp')) ||
                    fieldText(entry.fields.get('TOTP Seed')) ||
                    undefined,
                icon: entry.icon
            });
        }
        for (const subGroup of group.groups) {
            walk(subGroup, [...path, subGroup.name ?? '']);
        }
    };
    walk(db.getDefaultGroup(), []);
    return records;
}

// sourceEntry is only from combine-vaults; importers don't have live entries to copy attachments from.
async function createEntryFromRecord(
    db: Kdbx,
    group: KdbxGroup,
    record: VaultEntryRecord,
    sourceEntry?: KdbxEntry
): Promise<KdbxEntry> {
    const entry = db.createEntry(group);
    applyFields(db, entry, {
        title: record.title,
        username: record.username,
        password: record.password,
        url: record.url,
        notes: record.notes
    });
    if (record.tags?.length) {
        entry.tags = record.tags;
    }
    if (record.totpSecret) {
        entry.fields.set('otp', record.totpSecret);
    }
    if (record.icon !== undefined && record.icon !== Consts.Icons.Key) {
        entry.icon = record.icon;
    }
    if (sourceEntry) {
        // Fresh entry: no collision concerns, copy all attachments.
        await copyAttachments(db, entry, sourceEntry, true);
    }
    return entry;
}

function toConflictEntry(record: IdentifiedRecord): CombineConflictEntry {
    return { uuid: record.uuid, title: record.title, username: record.username, url: record.url };
}

// Merge matched pairs field-by-field; empty fields yield to populated ones; tags union (§9 addendum).
async function mergeRecordIntoEntry(
    db: Kdbx,
    entry: KdbxEntry,
    record: VaultEntryRecord,
    resolution: 'keep-a' | 'keep-b',
    sourceEntry: KdbxEntry
): Promise<void> {
    const preferSecondary = resolution === 'keep-b';
    applyFields(db, entry, {
        title: mergeStringField(fieldText(entry.fields.get('Title')), record.title, preferSecondary),
        username: mergeStringField(fieldText(entry.fields.get('UserName')), record.username, preferSecondary),
        password: mergeStringField(fieldText(entry.fields.get('Password')), record.password, preferSecondary),
        url: mergeStringField(fieldText(entry.fields.get('URL')), record.url, preferSecondary),
        notes: mergeStringField(fieldText(entry.fields.get('Notes')), record.notes, preferSecondary)
    });
    entry.tags = Array.from(new Set([...entry.tags, ...(record.tags ?? [])]));
    const existingTotp = fieldText(entry.fields.get('otp')) || fieldText(entry.fields.get('TOTP Seed'));
    const mergedTotp = mergeStringField(existingTotp, record.totpSecret ?? '', preferSecondary);
    if (mergedTotp && mergedTotp !== existingTotp) {
        entry.fields.set('otp', mergedTotp);
    }
    entry.icon = mergeIcon(entry.icon, record.icon, preferSecondary);
    await copyAttachments(db, entry, sourceEntry, preferSecondary);
    entry.times.update();
}

// Additive attachment merge: missing attachments added; collisions fall back to preferSecondary.
async function copyAttachments(
    db: Kdbx,
    targetEntry: KdbxEntry,
    sourceEntry: KdbxEntry,
    preferSecondary: boolean
): Promise<void> {
    for (const [name, binary] of sourceEntry.binaries) {
        if (targetEntry.binaries.has(name) && !preferSecondary) {
            continue;
        }
        const data = resolveBinary(binary);
        const copied = await db.createBinary(data);
        targetEntry.binaries.set(name, copied);
    }
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

function entryMatchesSearch(entry: KdbxEntry, lowerCaseTerm: string): boolean {
    if (fieldText(entry.fields.get('Title')).toLowerCase().includes(lowerCaseTerm)) {
        return true;
    }
    if (fieldText(entry.fields.get('UserName')).toLowerCase().includes(lowerCaseTerm)) {
        return true;
    }
    if (entryUrls(entry).some((url) => url.toLowerCase().includes(lowerCaseTerm))) {
        return true;
    }
    return fieldText(entry.fields.get('Password')).toLowerCase().includes(lowerCaseTerm);
}

function summarizeEntry(entry: KdbxEntry): EntrySummary {
    return {
        uuid: entry.uuid.id,
        title: fieldText(entry.fields.get('Title')),
        username: fieldText(entry.fields.get('UserName')),
        urls: entryUrls(entry),
        hasTotp: Boolean(fieldText(entry.fields.get('otp')) || fieldText(entry.fields.get('TOTP Seed'))),
        icon: entry.icon ?? Consts.Icons.Key,
        hasCustomIcon: entry.customIcon !== undefined
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

function resolveGroupPath(
    db: Kdbx,
    root: KdbxGroup,
    path: string,
    cache: Map<string, KdbxGroup>
): KdbxGroup {
    let current = root;
    let builtPath = root.uuid.id;
    for (const segment of path.split('/').map((s) => s.trim()).filter(Boolean)) {
        builtPath += `/${segment}`;
        let next = cache.get(builtPath);
        if (!next) {
            next = current.groups.find((g) => g.name === segment) ?? db.createGroup(current, segment);
            cache.set(builtPath, next);
        }
        current = next;
    }
    return current;
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

/** Runs `task` over `items` with at most `limit` in flight at once — a fixed worker pool, not a batch-and-wait loop. */
async function runWithConcurrency<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
    let index = 0;
    async function worker(): Promise<void> {
        while (index < items.length) {
            const item = items[index++];
            await task(item);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
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
