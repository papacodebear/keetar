import { getDomain } from 'tldts';
import { storage } from '../platform';

// Autofill trust (§ Options item 9): a host must be explicitly trusted before Keetar hands its
// content script a password. Trust is stored per registrable domain — same normalization already
// used for passkey rpId matching (passkey-store.ts) — so a Trust on example.com covers its subdomains.

export interface TrustedHost {
    domain: string;
    trustedAt: string;
}

const STORAGE_KEY = 'keetar.trustedHosts';

function registrableDomain(origin: string): string | undefined {
    try {
        return getDomain(new URL(origin).hostname) ?? undefined;
    } catch {
        return undefined;
    }
}

async function readAll(): Promise<TrustedHost[]> {
    return (await storage.get<TrustedHost[]>(STORAGE_KEY)) ?? [];
}

export async function listTrustedHosts(): Promise<TrustedHost[]> {
    return readAll();
}

export async function isHostTrusted(origin: string): Promise<boolean> {
    const domain = registrableDomain(origin);
    if (!domain) {
        return false;
    }
    return (await readAll()).some((host) => host.domain === domain);
}

export async function trustHost(origin: string): Promise<void> {
    const domain = registrableDomain(origin);
    if (!domain) {
        throw new Error('not a valid host to trust');
    }
    const existing = await readAll();
    if (existing.some((host) => host.domain === domain)) {
        return;
    }
    await storage.set(STORAGE_KEY, [...existing, { domain, trustedAt: new Date().toISOString() }]);
}

export async function revokeHost(domain: string): Promise<void> {
    const existing = await readAll();
    await storage.set(
        STORAGE_KEY,
        existing.filter((host) => host.domain !== domain)
    );
}
