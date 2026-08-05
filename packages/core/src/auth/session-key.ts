// Generic AES-KW wrap/unwrap of raw key material, given VUK (vault unlock
// key) bytes from a WebAuthn PRF assertion (§6.2). What actually gets
// wrapped is @keetar/web's concern (KdbxCredentials.passwordHash, per §6.2's
// note) — this module only knows about raw bytes in, raw bytes out.
//
// AES-KW (RFC 3394) wraps a CryptoKey, not raw bytes directly, so both sides
// of the ceremony round-trip through an import/export: the data being
// wrapped is imported as an (arbitrary, unused for actual encryption)
// AES-GCM key purely so it has a concrete algorithm to wrap under, then
// exported back to raw bytes on unwrap. The VUK itself becomes the AES-KW
// wrapping key, imported non-extractable — it never needs to leave
// SubtleCrypto as raw bytes again once it's done its one job.

export async function wrapKeyMaterial(data: ArrayBuffer, vuk: ArrayBuffer): Promise<ArrayBuffer> {
    const wrappingKey = await importWrappingKey(vuk);
    const keyToWrap = await globalThis.crypto.subtle.importKey(
        'raw',
        data,
        { name: 'AES-GCM', length: data.byteLength * 8 },
        true,
        ['encrypt', 'decrypt']
    );
    return globalThis.crypto.subtle.wrapKey('raw', keyToWrap, wrappingKey, { name: 'AES-KW' });
}

export async function unwrapKeyMaterial(wrapped: ArrayBuffer, vuk: ArrayBuffer, dataByteLength: number): Promise<ArrayBuffer> {
    const wrappingKey = await importWrappingKey(vuk);
    const unwrappedKey = await globalThis.crypto.subtle.unwrapKey(
        'raw',
        wrapped,
        wrappingKey,
        { name: 'AES-KW' },
        { name: 'AES-GCM', length: dataByteLength * 8 },
        true,
        ['encrypt', 'decrypt']
    );
    return globalThis.crypto.subtle.exportKey('raw', unwrappedKey);
}

function importWrappingKey(vuk: ArrayBuffer): Promise<CryptoKey> {
    return globalThis.crypto.subtle.importKey('raw', vuk, { name: 'AES-KW' }, false, [
        'wrapKey',
        'unwrapKey'
    ]);
}
