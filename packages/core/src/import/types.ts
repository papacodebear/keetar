// Generic shape all importers and exporters use; write side creates real KdbxEntry/KdbxGroup objects.
export interface VaultEntryRecord {
    title: string;
    username: string;
    password: string;
    url: string;
    notes: string;
    /** '/'-separated folder path, relative to wherever the caller imports into. Absent = no folder. */
    group?: string;
    tags?: string[];
    /** Raw base32 secret or a full otpauth:// URI — both are valid input to totp.ts's parseTotp(). */
    totpSecret?: string;
    /** KeePass icon index; only populated by KDBX-to-KDBX combine-vaults. */
    icon?: number;
}
