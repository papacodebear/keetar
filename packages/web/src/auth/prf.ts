// PRF extension handling (§6.2). TypeScript's bundled WebAuthn types don't
// include the `prf` extension yet (still a newer, evolving part of the
// spec), so its shapes are defined locally here rather than assumed
// available from lib.dom.d.ts.

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

/** The 32-byte VUK, if the authenticator evaluated PRF during this ceremony — undefined otherwise (§6.3: not every authenticator does, even when it supports PRF). */
export function extractVuk(credential: PublicKeyCredential): ArrayBuffer | undefined {
    return getExtensionResults(credential).prf?.results?.first;
}

/** Whether this credential supports PRF at all — distinct from whether *this* ceremony evaluated it (see extractVuk). */
export function isPrfEnabled(credential: PublicKeyCredential): boolean {
    return getExtensionResults(credential).prf?.enabled === true;
}
