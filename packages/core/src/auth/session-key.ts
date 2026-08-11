// AES-KW wrap/unwrap (RFC 3394): wraps key material via import/export CryptoKey ceremony with VUK.

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
