import type { FileListing, FileMetadata, FileProvider } from '@keetar/core';
import { identity } from '../platform';
import { loadTokens, removeTokens, saveTokens } from './oauth-token-store';

// Google Drive backend with drive.file scope (can only see files app created or user explicitly chose).
const PROVIDER_KEY = 'gdrive';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
// Exported for bridge; Firefox runs separate implicit-grant due to cross-site cookie isolation.
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

// Implicit grant: no client_secret (authorization_code requires it; Chrome Extension client broken); no refresh token—reauth silently when expired.
// Exported for bridge; needs manual console setup: google-picker-bridge.papacodebear.workers.dev/auth-return.html as redirect URI.
export const GOOGLE_CLIENT_ID = '131716196054-fbmcknr0o1m09973k9m9ksph52ec4n7e.apps.googleusercontent.com';

// Separate API key for Picker, restricted in Cloud Console by HTTP referrer.
export const GOOGLE_PICKER_API_KEY = 'AIzaSyD_jdWpKrQc8p5UBV8gm0WaVswo-o2PV_A';

// setAppId() is essential to register file grant under drive.file—skip it and API calls get 404.
export const GOOGLE_PICKER_APP_ID = GOOGLE_CLIENT_ID.split('-')[0];

/** Thrown by write()/read() when the file changed on Drive since this session last saw it — never silently overwritten (§4.3). */
export class CloudConflictError extends Error {
    constructor() {
        super('This vault changed in Google Drive since it was last read here. Reopen it to see the other change before saving again.');
        this.name = 'CloudConflictError';
    }
}

// File no longer resolves (404 from Drive API, distinct from other fetchFileMeta failures).
export class DriveFileNotFoundError extends Error {
    constructor() {
        super(
            'This database could not be found in Google Drive — it may have been deleted, or this account may no longer have access to it. Pick the file again from the database name.'
        );
        this.name = 'DriveFileNotFoundError';
    }
}

export async function connectGoogleDrive(): Promise<void> {
    const token = await authorizeImplicit(true);
    await saveTokens(PROVIDER_KEY, { accessToken: token.accessToken, refreshToken: undefined, expiresAt: token.expiresAt });
}

export async function isGoogleDriveConnected(): Promise<boolean> {
    return (await loadTokens(PROVIDER_KEY)) !== undefined;
}

export async function disconnectGoogleDrive(): Promise<void> {
    const stored = await loadTokens(PROVIDER_KEY);
    await removeTokens(PROVIDER_KEY);
    if (stored) {
        // Best-effort—revocation failing shouldn't block disconnect.
        try {
            await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(stored.accessToken)}`, {
                method: 'POST'
            });
        } catch {
            // ignored
        }
    }
}

async function authorizeImplicit(interactive: boolean): Promise<{ accessToken: string; expiresAt: number }> {
    const redirectUri = identity.getRedirectURL();
    const state = globalThis.crypto.randomUUID();

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'token');
    authUrl.searchParams.set('scope', DRIVE_SCOPE);
    authUrl.searchParams.set('state', state);

    let resultUrl: string | undefined;
    try {
        resultUrl = await identity.launchWebAuthFlow({ url: authUrl.toString(), interactive });
    } catch (e) {
        throw new Error(e instanceof Error ? e.message : 'authorization was cancelled');
    }
    if (!resultUrl) {
        throw new Error('authorization was cancelled');
    }

    // Implicit grant: response in fragment (#access_token=...), not query string (differs from authorization_code).
    const fragment = new URL(resultUrl).hash.slice(1);
    const params = new URLSearchParams(fragment);
    if (params.get('state') !== state) {
        throw new Error('OAuth state mismatch — possible response injection, aborting');
    }
    const accessToken = params.get('access_token');
    const expiresIn = params.get('expires_in');
    if (!accessToken || !expiresIn) {
        throw new Error(params.get('error_description') ?? params.get('error') ?? 'authorization failed');
    }
    return { accessToken, expiresAt: Date.now() + Number(expiresIn) * 1000 };
}

interface DriveFileFields {
    id: string;
    name: string;
    modifiedTime: string;
    headRevisionId?: string;
    size?: string;
}

export class GoogleDriveProvider implements FileProvider {
    private accessToken: string | undefined;
    // Session-scoped conflict guard: if headRevisionId moved, file changed elsewhere and write refuses to clobber.
    private lastKnownRevisionId: string | undefined;

    async read(path: string): Promise<ArrayBuffer> {
        const meta = await this.fetchFileMeta(path);
        this.lastKnownRevisionId = meta.headRevisionId;
        const response = await this.authorizedFetch(`${DRIVE_API}/files/${encodeURIComponent(path)}?alt=media`);
        if (!response.ok) {
            throw new Error(`Google Drive read failed: ${response.status}`);
        }
        return response.arrayBuffer();
    }

    async write(path: string, data: ArrayBuffer): Promise<FileMetadata> {
        const current = await this.fetchFileMeta(path);
        if (this.lastKnownRevisionId && current.headRevisionId && current.headRevisionId !== this.lastKnownRevisionId) {
            throw new CloudConflictError();
        }
        return this.uploadMedia(path, data);
    }

    // Bypasses revision guard (user explicitly chose to overwrite after conflict resolution).
    async forceWrite(path: string, data: ArrayBuffer): Promise<FileMetadata> {
        return this.uploadMedia(path, data);
    }

    private async uploadMedia(path: string, data: ArrayBuffer): Promise<FileMetadata> {
        const response = await this.authorizedFetch(
            `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(path)}?uploadType=media&fields=id,name,modifiedTime,headRevisionId,size`,
            { method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream' }, body: data }
        );
        if (!response.ok) {
            throw new Error(`Google Drive write failed: ${response.status}`);
        }
        const updated = (await response.json()) as DriveFileFields;
        this.lastKnownRevisionId = updated.headRevisionId;
        return toFileMetadata(updated);
    }

    async metadata(path: string): Promise<FileMetadata> {
        const meta = await this.fetchFileMeta(path);
        this.lastKnownRevisionId = meta.headRevisionId;
        return toFileMetadata(meta);
    }

    // Best-effort: under drive.file, only shows Keetar-created files (Picker is primary).
    async list(_dir: string): Promise<FileListing[]> {
        const response = await this.authorizedFetch(
            `${DRIVE_API}/files?q=${encodeURIComponent("trashed = false and name contains '.kdbx'")}&fields=files(id,name)&pageSize=50`
        );
        if (!response.ok) {
            throw new Error(`Google Drive list failed: ${response.status}`);
        }
        const { files } = (await response.json()) as { files: { id: string; name: string }[] };
        return files.map((f) => ({ path: f.id, name: f.name, isDirectory: false }));
    }

    async revoke(): Promise<void> {
        await disconnectGoogleDrive();
    }

    /** Not part of FileProvider — creating a brand-new Drive file is a one-time setup action (Options), not a per-save write(). */
    async createFile(name: string, data: ArrayBuffer): Promise<{ fileId: string }> {
        const boundary = `keetar-${globalThis.crypto.randomUUID()}`;
        const metadata = JSON.stringify({ name, mimeType: 'application/octet-stream' });
        const body = buildMultipartBody(boundary, metadata, data);

        const response = await this.authorizedFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, {
            method: 'POST',
            headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
            body
        });
        if (!response.ok) {
            throw new Error(`Google Drive create failed: ${response.status}`);
        }
        const created = (await response.json()) as { id: string };
        return { fileId: created.id };
    }

    private async fetchFileMeta(path: string): Promise<DriveFileFields> {
        const response = await this.authorizedFetch(
            `${DRIVE_API}/files/${encodeURIComponent(path)}?fields=id,name,modifiedTime,headRevisionId,size`
        );
        if (response.status === 404) {
            throw new DriveFileNotFoundError();
        }
        if (!response.ok) {
            throw new Error(`Google Drive metadata fetch failed: ${response.status}`);
        }
        return (await response.json()) as DriveFileFields;
    }

    private async authorizedFetch(url: string, init: RequestInit = {}, allowRetry = true): Promise<Response> {
        const token = await getAccessToken(this.accessToken);
        this.accessToken = token;
        const response = await fetch(url, {
            ...init,
            headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` }
        });
        if (response.status === 401 && allowRetry) {
            // Optimistic expiry check (clock skew, early revocation)—one forced refresh covers gap.
            this.accessToken = await getAccessToken(undefined, /* forceRefresh */ true);
            return this.authorizedFetch(url, init, false);
        }
        return response;
    }
}

// Exported for Picker flow to get token without full GoogleDriveProvider instance.
export async function getAccessToken(cached?: string, forceRefresh = false): Promise<string> {
    if (cached && !forceRefresh) {
        return cached;
    }

    const stored = await loadTokens(PROVIDER_KEY);
    if (!stored) {
        throw new Error('Google Drive is not connected');
    }
    const EXPIRY_MARGIN_MS = 60_000;
    if (!forceRefresh && Date.now() < stored.expiresAt - EXPIRY_MARGIN_MS) {
        return stored.accessToken;
    }
    // Token expired—rerun implicit flow silently (no refresh token); works if user still signed into Google.
    const refreshed = await authorizeImplicit(false);
    await saveTokens(PROVIDER_KEY, { accessToken: refreshed.accessToken, refreshToken: undefined, expiresAt: refreshed.expiresAt });
    return refreshed.accessToken;
}

function toFileMetadata(fields: DriveFileFields): FileMetadata {
    return {
        lastModified: fields.modifiedTime,
        eTag: fields.headRevisionId ?? '',
        size: fields.size ? Number(fields.size) : 0
    };
}

function buildMultipartBody(boundary: string, metadataJson: string, data: ArrayBuffer): Blob {
    return new Blob([
        `--${boundary}\r\n`,
        'Content-Type: application/json; charset=UTF-8\r\n\r\n',
        metadataJson,
        `\r\n--${boundary}\r\n`,
        'Content-Type: application/octet-stream\r\n\r\n',
        data,
        `\r\n--${boundary}--`
    ]);
}
