import type { FileProvider, FileMetadata, FileListing } from '@keetar/core';
/**
 * Shows the native file picker and persists the resulting handle. Only
 * callable from a document context with active user activation (a service
 * worker has no window and cannot show this picker) — see §4.2.
 */
export declare function pickVaultFile(): Promise<{
    uuid: string;
    name: string;
}>;
export declare class LocalFileProvider implements FileProvider {
    private readonly uuid;
    constructor(uuid: string);
    read(_path: string): Promise<ArrayBuffer>;
    write(_path: string, data: ArrayBuffer): Promise<FileMetadata>;
    metadata(_path: string): Promise<FileMetadata>;
    list(_dir: string): Promise<FileListing[]>;
    revoke(): Promise<void>;
    private getHandle;
    private ensurePermission;
}
//# sourceMappingURL=local-file.d.ts.map