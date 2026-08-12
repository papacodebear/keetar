// On-demand favicon download in background context (Chrome MV3/Firefox MV2).
const CANDIDATE_PATHS = ['/favicon.ico', '/favicon.png'];

export async function fetchFaviconPng(entryUrl: string): Promise<ArrayBuffer> {
    const origin = faviconOrigin(entryUrl);

    for (const path of CANDIDATE_PATHS) {
        try {
            const response = await fetch(origin + path);
            if (!response.ok) {
                continue;
            }
            const blob = await response.blob();
            return await rasterizeToPng(blob);
        } catch {
            // Try next candidate on network failure or decode error.
            continue;
        }
    }
    throw new Error(`no favicon found at ${origin}`);
}

/**
 * Converts common saved URL variants into an HTTP(S) origin for favicon
 * lookup. Bare domains are treated as HTTPS. For a hostname-style regex with
 * alternatives, select its first alternative: `(drive|photos|mail).google.com`
 * becomes `https://drive.google.com`.
 */
export function faviconOrigin(entryUrl: string): string {
    const value = entryUrl.trim();
    if (!value) {
        throw new Error('entry has no valid URL to fetch a favicon from');
    }

    const directOrigin = originFromUrl(value);
    if (directOrigin) {
        return directOrigin;
    }

    const regexHost = selectFirstHostAlternative(value);
    const regexOrigin = originFromUrl(regexHost);
    if (regexOrigin) {
        return regexOrigin;
    }

    throw new Error('entry has no valid URL to fetch a favicon from');
}

function originFromUrl(value: string): string | undefined {
    const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
    if (!hasScheme && /^[a-z][a-z\d+.-]*:/i.test(value)) {
        return undefined;
    }
    try {
        const url = new URL(hasScheme ? value : `https://${value}`);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
    } catch {
        return undefined;
    }
}

function selectFirstHostAlternative(value: string): string {
    return value
        .replace(/^\^/, '')
        .replace(/\$$/, '')
        .replace(/\(([^()|]+(?:\|[^()|]+)+)\)/g, (_match, alternatives: string) => alternatives.split('|')[0])
        .replace(/\\([.])/g, '$1');
}

// Re-encode .ico to PNG for consistent storage format across clients.
async function rasterizeToPng(blob: Blob): Promise<ArrayBuffer> {
    const bitmap = await createImageBitmap(blob);
    try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            throw new Error('2D canvas context unavailable');
        }
        ctx.drawImage(bitmap, 0, 0);
        const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
        return await pngBlob.arrayBuffer();
    } finally {
        bitmap.close();
    }
}
