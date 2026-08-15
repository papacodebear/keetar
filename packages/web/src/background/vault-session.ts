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
import type { CapturedLogin } from './login-capture';
import { isReservedFieldName } from './reserved-fields';
import { buildFieldReference, parseFieldReference } from './field-reference';
import { applyCloneAwareness, type CloneAwareEntry } from './clone-aware-health';
import {
    isRpIdValidForOrigin,
    matchEntriesForRpId,
    passkeyAttachmentName,
    decodePasskeyRecord,
    encodePasskeyRecord,
    parsePasskeyIndex,
    serializePasskeyIndex,
    PASSKEY_INDEX_FIELD
} from './passkey-store';
import {
    base64UrlDecode,
    base64UrlEncode,
    buildAttestationObject,
    buildAttestedCredentialData,
    buildAuthenticatorData,
    buildClientDataJson,
    concatBytes,
    exportCosePublicKey,
    exportPkcs8,
    generateP256KeyPair,
    importPkcs8PrivateKey,
    sha256,
    signWithDer
} from '../passkey-provider/webauthn-crypto';
import {
    findExactDuplicateGroups,
    findExactDuplicateMatches,
    findDuplicateGroups,
    entriesToRemoveFromDuplicateGroups,
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

export interface EntryCustomField {
    name: string;
    value: string;
    protected: boolean;
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
    customFields: EntryCustomField[];
    /** Set when Username/Password are live KeePass field references to another entry (a "clone"). */
    clonedFromEntryUuid: string | undefined;
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

export interface DuplicateCredentialEntry {
    uuid: string;
    title: string;
    groupPath: string;
}

export interface DuplicateCredentialGroup {
    entries: DuplicateCredentialEntry[];
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
        | {
              exactMatches: ReturnType<typeof findExactDuplicateMatches>;
              identicalGroups: DedupGroup[];
              divergentGroups: DedupGroup[];
              nonConflicting: IdentifiedRecord[];
          }
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
        const db = this.requireUnlocked();
        const entry = this.requireEntry(entryUuid);
        const fieldName = field === 'username' ? 'UserName' : 'Password';
        return resolveFieldValue(db, fieldText(entry.fields.get(fieldName)));
    }

    matchesEntryCredentials(entryUuid: string, username: string, password: string): boolean {
        const db = this.requireUnlocked();
        const entry = this.requireEntry(entryUuid);
        return (
            resolveFieldValue(db, fieldText(entry.fields.get('UserName'))) === username &&
            resolveFieldValue(db, fieldText(entry.fields.get('Password'))) === password
        );
    }

    matchesEntryPassword(entryUuid: string, password: string): boolean {
        const db = this.requireUnlocked();
        const entry = this.requireEntry(entryUuid);
        return resolveFieldValue(db, fieldText(entry.fields.get('Password'))) === password;
    }

    getEntryTotp(entryUuid: string): Promise<Totp.TotpCode> {
        const entry = this.requireEntry(entryUuid);
        const value = fieldText(entry.fields.get('otp')) || fieldText(entry.fields.get('TOTP Seed'));
        if (!value) {
            throw new Error('entry has no TOTP secret');
        }
        return Totp.generateTotpCode(value);
    }

    async getPasswordHealth(): Promise<PasswordHealthReport> {
        const db = this.requireUnlocked();
        const recycleBinUuid = db.meta.recycleBinUuid;
        const cloneEntries: CloneAwareEntry[] = [];
        const entries = Array.from(db.getDefaultGroup().allEntries())
            .filter((entry) => !recycleBinUuid || !isInGroup(entry, recycleBinUuid))
            .map((entry) => {
                const rawPassword = fieldText(entry.fields.get('Password'));
                const ref = parseFieldReference(rawPassword);
                const source = ref && findEntryByUuidHex(db.getDefaultGroup(), ref.uuidHex);
                const password = source ? resolveFieldValue(db, rawPassword) : rawPassword;
                cloneEntries.push({ uuid: entry.uuid.id, password, clonedFromEntryUuid: source?.uuid.id });
                return {
                    uuid: entry.uuid.id,
                    title: fieldText(entry.fields.get('Title')),
                    password,
                    // A clone's meaningful "age" is when the shared credential was last actually changed.
                    lastModified: source ? source.times.lastModTime : entry.times.lastModTime
                };
            });
        const report = await analysePasswordHealth(entries, (password) => this.hibpClient.checkPassword(password));
        return applyCloneAwareness(report, cloneEntries);
    }

    getDuplicateCredentialGroups(): DuplicateCredentialGroup[] {
        const db = this.requireUnlocked();
        return findExactDuplicateGroups(kdbxToRecords(db)).map(({ entries }) => ({
            entries: entries.map((entry) => ({
                uuid: entry.uuid,
                title: entry.title,
                groupPath: entry.group || 'Root'
            }))
        }));
    }

    async removeDuplicateEntries(keepEntryUuids: string[]): Promise<number> {
        const db = this.requireUnlocked();
        const groups = findExactDuplicateGroups(kdbxToRecords(db));
        const entriesToRemove = entriesToRemoveFromDuplicateGroups(groups, keepEntryUuids);
        for (const record of entriesToRemove) {
            const entry = this.requireEntry(record.uuid);
            db.remove(entry);
        }
        if (entriesToRemove.length > 0) {
            await this.persist();
        }
        return entriesToRemove.length;
    }

    // Full vault tree for Manager (§8.2), including recycle bin.
    getGroupTree(): { root: GroupNode; recycleBinGroupUuid: string | undefined } {
        const db = this.requireUnlocked();
        return { root: toGroupNode(db.getDefaultGroup()), recycleBinGroupUuid: db.meta.recycleBinUuid?.id };
    }

    getEntryDetail(entryUuid: string): EntryDetail {
        const db = this.requireUnlocked();
        const entry = this.requireEntry(entryUuid);
        if (!entry.parentGroup) {
            throw new Error('entry has no parent group');
        }
        const rawPassword = fieldText(entry.fields.get('Password'));
        const passwordRef = parseFieldReference(rawPassword);
        const cloneSource = passwordRef && findEntryByUuidHex(db.getDefaultGroup(), passwordRef.uuidHex);
        return {
            uuid: entry.uuid.id,
            groupUuid: entry.parentGroup.uuid.id,
            title: fieldText(entry.fields.get('Title')),
            username: resolveFieldValue(db, fieldText(entry.fields.get('UserName'))),
            password: resolveFieldValue(db, rawPassword),
            url: fieldText(entry.fields.get('URL')),
            notes: fieldText(entry.fields.get('Notes')),
            clonedFromEntryUuid: cloneSource?.uuid.id,
            attachments: Array.from(entry.binaries.entries()).map(([name, value]) => ({
                name,
                size: resolveBinary(value).byteLength
            })),
            customFields: customFieldsOf(entry),
            icon: entry.icon ?? Consts.Icons.Key,
            hasCustomIcon: entry.customIcon !== undefined
        };
    }

    async setCustomField(entryUuid: string, name: string, value: string, protect: boolean): Promise<void> {
        const entry = this.requireEntry(entryUuid);
        validateCustomFieldName(entry, name);
        entry.pushHistory();
        entry.fields.set(name, protect ? ProtectedValue.fromString(value) : value);
        entry.times.update();
        await this.persist();
    }

    async renameCustomField(entryUuid: string, oldName: string, newName: string): Promise<void> {
        const entry = this.requireEntry(entryUuid);
        if (isReservedFieldName(oldName)) {
            throw new Error('field is not a custom field');
        }
        const existing = entry.fields.get(oldName);
        if (existing === undefined) {
            throw new Error('field not found');
        }
        if (newName !== oldName) {
            validateCustomFieldName(entry, newName);
        }
        entry.pushHistory();
        entry.fields.delete(oldName);
        entry.fields.set(newName, existing);
        entry.times.update();
        await this.persist();
    }

    async removeCustomField(entryUuid: string, name: string): Promise<void> {
        const entry = this.requireEntry(entryUuid);
        if (isReservedFieldName(name)) {
            throw new Error('field is not a custom field');
        }
        entry.pushHistory();
        entry.fields.delete(name);
        entry.times.update();
        await this.persist();
    }

    // Sets or clears a "clone" relationship: Username/Password become live KeePass {REF:...}
    // field references to the source entry, so edits to the source propagate automatically.
    async setEntryClone(entryUuid: string, sourceEntryUuid: string | undefined): Promise<void> {
        const db = this.requireUnlocked();
        const entry = this.requireEntry(entryUuid);
        entry.pushHistory();
        if (sourceEntryUuid) {
            if (sourceEntryUuid === entryUuid) {
                throw new Error('an entry cannot clone itself');
            }
            const source = this.requireEntry(sourceEntryUuid);
            const hex = uuidHexOf(source);
            const protection = db.meta.memoryProtection;
            const usernameRef = buildFieldReference('U', hex);
            const passwordRef = buildFieldReference('P', hex);
            entry.fields.set('UserName', protection.userName ? ProtectedValue.fromString(usernameRef) : usernameRef);
            entry.fields.set('Password', protection.password ? ProtectedValue.fromString(passwordRef) : passwordRef);
        } else {
            entry.fields.set('UserName', '');
            entry.fields.set('Password', '');
        }
        entry.times.update();
        await this.persist();
    }

    // WebAuthn create(): keypair never leaves this method; only public bytes go back to the caller.
    async createPasskey(params: {
        rpId: string;
        origin: string;
        userName: string;
        userHandleBase64Url: string;
        userDisplayName?: string;
        entryUuid?: string;
        createNewEntry?: boolean;
    }): Promise<{ entryUuid: string; credentialId: string; publicKeyCoseBase64: string; attestationObjectBase64: string }> {
        const db = this.requireUnlocked();
        if (!isRpIdValidForOrigin(params.rpId, params.origin)) {
            throw new Error('rpId does not match the page origin');
        }

        const { entry, isNew } = this.resolvePasskeyEntry(db, params);
        if (!isNew) {
            entry.pushHistory();
        }

        const keyPair = await generateP256KeyPair();
        const credentialId = crypto.getRandomValues(new Uint8Array(32));
        const [privateKeyPkcs8, cosePublicKey] = await Promise.all([
            exportPkcs8(keyPair.privateKey),
            exportCosePublicKey(keyPair.publicKey)
        ]);

        const record = encodePasskeyRecord({
            credentialId,
            privateKeyPkcs8,
            userHandle: base64UrlDecode(params.userHandleBase64Url),
            algorithm: -7,
            rpId: params.rpId,
            signCount: 0
        });
        entry.binaries.set(passkeyAttachmentName(credentialId), await db.createBinary(ProtectedValue.fromBinary(record)));

        const index = parsePasskeyIndex(fieldText(entry.fields.get(PASSKEY_INDEX_FIELD)));
        index.push({ credentialId: base64UrlEncode(credentialId), rpId: params.rpId });
        entry.fields.set(PASSKEY_INDEX_FIELD, serializePasskeyIndex(index));

        entry.times.update();
        await this.persist();

        const attestedCredentialData = buildAttestedCredentialData(credentialId, cosePublicKey);
        const authenticatorData = await buildAuthenticatorData({
            rpId: params.rpId,
            signCount: 0,
            attestedCredentialData
        });

        return {
            entryUuid: entry.uuid.id,
            credentialId: base64UrlEncode(credentialId),
            publicKeyCoseBase64: ByteUtils.bytesToBase64(cosePublicKey),
            attestationObjectBase64: ByteUtils.bytesToBase64(buildAttestationObject(authenticatorData))
        };
    }

    // WebAuthn get(): re-validates rpId itself rather than trusting the caller (§ Security).
    async signPasskeyAssertion(params: {
        entryUuid: string;
        credentialId: string;
        rpId: string;
        origin: string;
        challengeBase64: string;
    }): Promise<{ signatureBase64: string; authenticatorDataBase64: string; userHandleBase64Url: string; signCount: number }> {
        if (!isRpIdValidForOrigin(params.rpId, params.origin)) {
            throw new Error('rpId does not match the page origin');
        }
        const db = this.requireUnlocked();
        const entry = this.requireEntry(params.entryUuid);
        const credentialIdBytes = base64UrlDecode(params.credentialId);
        const attachmentName = passkeyAttachmentName(credentialIdBytes);
        const binary = entry.binaries.get(attachmentName);
        if (!binary) {
            throw new Error('passkey not found on entry');
        }
        const record = decodePasskeyRecord(new Uint8Array(resolveBinary(binary)));
        if (record.rpId !== params.rpId) {
            throw new Error('passkey does not belong to this site');
        }

        const privateKey = await importPkcs8PrivateKey(record.privateKeyPkcs8);
        const nextSignCount = record.signCount + 1;
        const authenticatorData = await buildAuthenticatorData({ rpId: params.rpId, signCount: nextSignCount });
        const clientDataJson = buildClientDataJson({
            type: 'webauthn.get',
            challenge: ByteUtils.base64ToBytes(params.challengeBase64),
            origin: params.origin
        });
        const clientDataHash = await sha256(clientDataJson);
        const signature = await signWithDer(privateKey, concatBytes([authenticatorData, clientDataHash]));

        entry.binaries.set(
            attachmentName,
            await db.createBinary(
                ProtectedValue.fromBinary(encodePasskeyRecord({ ...record, signCount: nextSignCount }))
            )
        );
        entry.times.update();
        await this.persist();

        return {
            signatureBase64: ByteUtils.bytesToBase64(signature),
            authenticatorDataBase64: ByteUtils.bytesToBase64(authenticatorData),
            userHandleBase64Url: base64UrlEncode(record.userHandle),
            signCount: nextSignCount
        };
    }

    listPasskeysForRpId(
        rpId: string,
        allowCredentialIds?: string[]
    ): { entryUuid: string; entryTitle: string; credentialId: string }[] {
        const db = this.requireUnlocked();
        const recycleBinUuid = db.meta.recycleBinUuid;
        const allowSet = allowCredentialIds ? new Set(allowCredentialIds) : undefined;
        const results: { entryUuid: string; entryTitle: string; credentialId: string }[] = [];
        const walk = (group: KdbxGroup) => {
            if (recycleBinUuid && group.uuid.equals(recycleBinUuid)) {
                return;
            }
            for (const entry of group.entries) {
                for (const item of parsePasskeyIndex(fieldText(entry.fields.get(PASSKEY_INDEX_FIELD)))) {
                    if (item.rpId !== rpId || (allowSet && !allowSet.has(item.credentialId))) {
                        continue;
                    }
                    results.push({
                        entryUuid: entry.uuid.id,
                        entryTitle: fieldText(entry.fields.get('Title')),
                        credentialId: item.credentialId
                    });
                }
            }
            for (const subGroup of group.groups) {
                walk(subGroup);
            }
        };
        walk(db.getDefaultGroup());
        return results;
    }

    private resolvePasskeyEntry(
        db: Kdbx,
        params: { rpId: string; userName: string; userDisplayName?: string; entryUuid?: string; createNewEntry?: boolean }
    ): { entry: KdbxEntry; isNew: boolean } {
        if (params.entryUuid) {
            return { entry: this.requireEntry(params.entryUuid), isNew: false };
        }
        if (!params.createNewEntry) {
            const matches = matchEntriesForRpId(this.listEntries(), params.rpId);
            if (matches.length === 1) {
                return { entry: this.requireEntry(matches[0].uuid), isNew: false };
            }
            if (matches.length > 1) {
                throw new Error('multiple entries match this site; choose one explicitly');
            }
        }
        const entry = db.createEntry(db.getDefaultGroup());
        applyFields(db, entry, {
            title: params.userDisplayName || params.rpId,
            username: params.userName,
            url: `https://${params.rpId}`
        });
        return { entry, isNew: true };
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

    /** Saves a reviewed login capture at the vault root and fetches its favicon when available. */
    async createEntryFromCapturedLogin(login: CapturedLogin & { username: string; password: string }): Promise<EntrySummary> {
        const db = this.requireUnlocked();
        const entry = db.createEntry(db.getDefaultGroup());
        applyFields(db, entry, loginFields(login));
        try {
            await this.applyFaviconToEntry(db, entry);
        } catch {
            // A favicon is an enhancement; it must not prevent the credential from being saved.
        }
        await this.persist();
        return summarizeEntry(entry);
    }

    /** Updates a reviewed entry from a login capture, preserving an existing custom icon. */
    async updateEntryFromCapturedLogin(entryUuid: string, login: CapturedLogin & { password: string }): Promise<void> {
        const db = this.requireUnlocked();
        const entry = this.requireEntry(entryUuid);
        entry.pushHistory();
        applyFields(db, entry, loginFields(login));
        if (!entry.customIcon) {
            try {
                await this.applyFaviconToEntry(db, entry);
            } catch {
                // A favicon is an enhancement; it must not prevent the credential update.
            }
        }
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

    // db.remove() always redirects into the recycle bin — permanently delete its contents with move(x, null) instead.
    async emptyRecycleBin(): Promise<{ deletedEntries: number; deletedGroups: number }> {
        const db = this.requireUnlocked();
        const recycleBinUuid = db.meta.recycleBinUuid;
        const recycleBin = recycleBinUuid ? db.getGroup(recycleBinUuid) : undefined;
        if (!recycleBin) {
            return { deletedEntries: 0, deletedGroups: 0 };
        }
        const deletedEntries = Array.from(recycleBin.allEntries()).length;
        const deletedGroups = Array.from(recycleBin.allGroups()).length - 1;

        // Snapshot first — move() splices these same arrays as it goes.
        for (const entry of [...recycleBin.entries]) {
            db.move(entry, null);
        }
        for (const group of [...recycleBin.groups]) {
            db.move(group, null);
        }
        await this.persist();
        return { deletedEntries, deletedGroups };
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

    // Compute conflict groups; exact credentials are never re-imported, even when their group paths differ.
    previewCombine(): { conflicts: CombineConflict[]; nonConflictingCount: number; identicalCount: number } {
        const db = this.requireUnlocked();
        if (!this.secondaryDb) {
            throw new Error('no secondary vault open');
        }
        const primaryRecords = kdbxToRecords(db);
        const secondaryRecords = kdbxToRecords(this.secondaryDb);
        const exactMatches = findExactDuplicateMatches(primaryRecords, secondaryRecords);
        const exactSecondaryUuids = new Set(exactMatches.map((match) => match.secondary.uuid));
        const candidateSecondaryRecords = secondaryRecords.filter((record) => !exactSecondaryUuids.has(record.uuid));
        const allGroups = findDuplicateGroups(primaryRecords, candidateSecondaryRecords);
        const { identical, divergent } = partitionByPasswordMatch(allGroups);
        const nonConflicting = findNonConflicting(candidateSecondaryRecords, allGroups);
        this.pendingCombine = { exactMatches, identicalGroups: identical, divergentGroups: divergent, nonConflicting };
        return {
            conflicts: divergent.map((group) => ({
                key: group.key,
                primary: group.primary.map(toConflictEntry),
                secondary: group.secondary.map(toConflictEntry)
            })),
            nonConflictingCount: nonConflicting.length,
            identicalCount: exactMatches.length + identical.length
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

        // Exact matches are never imported; retain useful non-credential fields from the incoming record.
        for (const match of this.pendingCombine.exactMatches) {
            await mergeInto(match.primary, match.secondary, 'keep-a');
        }

        // Auto-resolved same-site/password pairs: still merge non-password fields that may differ.
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
        // Prune unreferenced binaries — content-addressed, so replaced attachments leak otherwise.
        db.cleanup({ binaries: true, customIcons: true });
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

function uuidHexOf(entry: KdbxEntry): string {
    return ByteUtils.bytesToHex(entry.uuid.bytes).toUpperCase();
}

function findEntryByUuidHex(group: KdbxGroup, uuidHex: string): KdbxEntry | undefined {
    for (const entry of group.entries) {
        if (uuidHexOf(entry) === uuidHex) {
            return entry;
        }
    }
    for (const subGroup of group.groups) {
        const found = findEntryByUuidHex(subGroup, uuidHex);
        if (found) {
            return found;
        }
    }
    return undefined;
}

const REF_FIELD_TO_KDBX_NAME: Record<string, string> = {
    T: 'Title',
    U: 'UserName',
    P: 'Password',
    A: 'URL',
    N: 'Notes'
};
const MAX_FIELD_REFERENCE_DEPTH = 4;

// Resolves KeePass {REF:...} field references (a "cloned" entry's shared Username/Password) —
// a shallow depth cap guards against reference chains/cycles.
function resolveFieldValue(db: Kdbx, rawValue: string, depth = 0): string {
    if (depth >= MAX_FIELD_REFERENCE_DEPTH) {
        return rawValue;
    }
    const ref = parseFieldReference(rawValue);
    const kdbxName = ref && REF_FIELD_TO_KDBX_NAME[ref.field];
    const source = kdbxName ? findEntryByUuidHex(db.getDefaultGroup(), ref.uuidHex) : undefined;
    if (!kdbxName || !source) {
        return rawValue;
    }
    return resolveFieldValue(db, fieldText(source.fields.get(kdbxName)), depth + 1);
}

function customFieldsOf(entry: KdbxEntry): EntryCustomField[] {
    const fields: EntryCustomField[] = [];
    for (const [name, value] of entry.fields) {
        if (isReservedFieldName(name)) {
            continue;
        }
        fields.push({ name, value: fieldText(value), protected: value instanceof ProtectedValue });
    }
    return fields;
}

function validateCustomFieldName(entry: KdbxEntry, name: string): void {
    if (!name.trim()) {
        throw new Error('field name cannot be empty');
    }
    if (isReservedFieldName(name)) {
        throw new Error('field name is reserved');
    }
    if (entry.fields.has(name)) {
        throw new Error('a field with that name already exists');
    }
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

// A username-less capture (e.g. a change-password form) only ever touches the password —
// applyFields skips undefined fields, so title/username/url are left untouched on the entry.
function loginFields(login: CapturedLogin & { password: string }): EntryFields {
    return {
        title: login.username ? login.title.trim() || login.url : undefined,
        username: login.username,
        password: login.password,
        url: login.username ? login.url : undefined
    };
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
