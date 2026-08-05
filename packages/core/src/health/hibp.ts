export type HibpFetch = (url: string) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;

export interface HibpClient {
    checkPassword(password: string): Promise<number>;
}

export function createHibpClient(fetchFn: HibpFetch = globalThis.fetch): HibpClient {
    const ranges = new Map<string, Promise<Map<string, number>>>();

    return {
        async checkPassword(password: string): Promise<number> {
            const hash = await sha1(password);
            const prefix = hash.slice(0, 5);
            let range = ranges.get(prefix);
            if (!range) {
                range = loadRange(prefix, fetchFn);
                ranges.set(prefix, range);
            }
            try {
                return (await range).get(hash.slice(5)) ?? 0;
            } catch (error) {
                ranges.delete(prefix);
                throw error;
            }
        }
    };
}

export async function checkPasswordBreach(password: string, fetchFn?: HibpFetch): Promise<number> {
    return createHibpClient(fetchFn).checkPassword(password);
}

async function loadRange(prefix: string, fetchFn: HibpFetch): Promise<Map<string, number>> {
    const response = await fetchFn(`https://api.pwnedpasswords.com/range/${prefix}`);
    if (!response.ok) {
        throw new Error(`HIBP request failed with status ${response.status}`);
    }
    const counts = new Map<string, number>();
    for (const line of (await response.text()).split(/\r?\n/)) {
        const match = /^([A-F0-9]{35}):(\d+)$/.exec(line);
        if (match) {
            counts.set(match[1], Number(match[2]));
        }
    }
    return counts;
}

async function sha1(value: string): Promise<string> {
    const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', new TextEncoder().encode(value)));
    return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
}