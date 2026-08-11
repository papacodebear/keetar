// PRF extension types (not yet in TypeScript lib.dom.d.ts; §6.2).

export interface PrfExtensionInput {
    prf: { eval?: { first: BufferSource } };
}

export interface PrfExtensionResults {
    prf?: {
        enabled?: boolean;
        results?: { first?: ArrayBuffer };
    };
}

function getExtensionResults(credential: PublicKeyCredential): PrfExtensionResults {
    return credential.getClientExtensionResults() as PrfExtensionResults;
}

// Extract VUK if PRF was evaluated in ceremony (not all authenticators do; §6.3).
export function extractVuk(credential: PublicKeyCredential): ArrayBuffer | undefined {
    return getExtensionResults(credential).prf?.results?.first;
}

// Check if credential supports PRF (distinct from whether ceremony evaluated it).
export function isPrfEnabled(credential: PublicKeyCredential): boolean {
    return getExtensionResults(credential).prf?.enabled === true;
}
