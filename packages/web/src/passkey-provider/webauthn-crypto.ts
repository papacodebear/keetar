import { ByteUtils } from '@keetar/core';
import { encodeCborMap, type CborMap } from './cbor';

// ES256 (P-256) only, attestation format "none" — the WebAuthn subset this plan covers.

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;
const ZERO_AAGUID = new Uint8Array(16);

export function base64UrlEncode(bytes: Uint8Array): string {
    return ByteUtils.bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    return ByteUtils.base64ToBytes(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='));
}

// WebCrypto's BufferSource wants a real ArrayBuffer, not the wider ArrayBufferLike a Uint8Array carries.
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

export async function generateP256KeyPair(): Promise<CryptoKeyPair> {
    return (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
        'verify'
    ])) as CryptoKeyPair;
}

export async function exportPkcs8(privateKey: CryptoKey): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey));
}

export async function importPkcs8PrivateKey(bytes: Uint8Array): Promise<CryptoKey> {
    return crypto.subtle.importKey('pkcs8', toArrayBuffer(bytes), { name: 'ECDSA', namedCurve: 'P-256' }, false, [
        'sign'
    ]);
}

// COSE_Key (RFC 9053) for a P-256 point: kty=EC2(2), alg=ES256(-7), crv=P-256(1), x, y.
export async function exportCosePublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey)); // 0x04 || X(32) || Y(32)
    const map: CborMap = new Map();
    map.set(1, 2);
    map.set(3, -7);
    map.set(-1, 1);
    map.set(-2, raw.slice(1, 33));
    map.set(-3, raw.slice(33, 65));
    return encodeCborMap(map);
}

async function rpIdHash(rpId: string): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
}

function encodeSignCount(count: number): Uint8Array {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, count, false);
    return bytes;
}

export function buildAttestedCredentialData(credentialId: Uint8Array, cosePublicKey: Uint8Array): Uint8Array {
    const credIdLength = new Uint8Array(2);
    new DataView(credIdLength.buffer).setUint16(0, credentialId.length, false);
    return concatBytes([ZERO_AAGUID, credIdLength, credentialId, cosePublicKey]);
}

export async function buildAuthenticatorData(options: {
    rpId: string;
    signCount: number;
    attestedCredentialData?: Uint8Array;
}): Promise<Uint8Array> {
    const flags =
        FLAG_USER_PRESENT | FLAG_USER_VERIFIED | (options.attestedCredentialData ? FLAG_ATTESTED_CREDENTIAL_DATA : 0);
    const parts = [await rpIdHash(options.rpId), Uint8Array.of(flags), encodeSignCount(options.signCount)];
    if (options.attestedCredentialData) {
        parts.push(options.attestedCredentialData);
    }
    return concatBytes(parts);
}

export function buildAttestationObject(authData: Uint8Array): Uint8Array {
    const map: CborMap = new Map();
    map.set('fmt', 'none');
    map.set('attStmt', new Map());
    map.set('authData', authData);
    return encodeCborMap(map);
}

export function buildClientDataJson(options: {
    type: 'webauthn.create' | 'webauthn.get';
    challenge: Uint8Array;
    origin: string;
}): Uint8Array {
    const json = JSON.stringify({
        type: options.type,
        challenge: base64UrlEncode(options.challenge),
        origin: options.origin
    });
    return new TextEncoder().encode(json);
}

// WebCrypto ECDSA signatures are raw r||s; WebAuthn assertion signatures must be ASN.1 DER.
function derInteger(bytes: Uint8Array): number[] {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) {
        start++;
    }
    let trimmed = bytes.slice(start);
    if (trimmed[0] & 0x80) {
        trimmed = Uint8Array.from([0, ...trimmed]);
    }
    return [0x02, trimmed.length, ...trimmed];
}

function rawEcdsaSignatureToDer(raw: Uint8Array): Uint8Array {
    const half = raw.length / 2;
    const body = [...derInteger(raw.slice(0, half)), ...derInteger(raw.slice(half))];
    return Uint8Array.from([0x30, body.length, ...body]);
}

export async function signWithDer(privateKey: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
    const raw = new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, toArrayBuffer(data))
    );
    return rawEcdsaSignatureToDer(raw);
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(data)));
}
