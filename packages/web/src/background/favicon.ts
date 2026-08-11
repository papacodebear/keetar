// On-demand favicon download in background context (Chrome MV3/Firefox MV2).
const CANDIDATE_PATHS = ['/favicon.ico', '/favicon.png'];

export async function fetchFaviconPng(entryUrl: string): Promise<ArrayBuffer> {
    let origin: string;
    try {
        origin = new URL(entryUrl).origin;
    } catch {
        throw new Error('entry has no valid URL to fetch a favicon from');
    }

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
