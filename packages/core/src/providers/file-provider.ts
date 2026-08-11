// Storage contract interface — consumers implement this against their storage backend.

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
