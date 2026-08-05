// Storage contract (§7.1, §2.5). Type only — no implementation lives here.
// Consumers of @keetar/core (a browser extension, a Node CLI, a future
// desktop app) implement this against their own storage without pulling in
// any extension-specific code.

export interface FileMetadata {
    lastModified: string; // ISO 8601
    eTag: string;
    size: number;
}

export interface FileListing {
    path: string;
    name: string;
    isDirectory: boolean;
}

export interface FileProvider {
    read(path: string): Promise<ArrayBuffer>;
    write(path: string, data: ArrayBuffer): Promise<FileMetadata>;
    metadata(path: string): Promise<FileMetadata>;
    list(dir: string): Promise<FileListing[]>;
    revoke(): Promise<void>;
}
