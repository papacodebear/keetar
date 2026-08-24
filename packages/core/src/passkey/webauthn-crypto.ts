import * as ByteUtils from '../utils/byte-utils.js';
import { encodeCborMap, type CborMap } from './cbor.js';

// Keetar itself only ever generates ES256; RS256/EdDSA support is for signing with existing keys.

export type PasskeyAlgorithm = 'ES256' | 'RS256' | 'EdDSA';

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL_DATA = 0x40;
const ZERO_AAGUID = new Uint8Array(16);

export function base64UrlEncode(bytes: Uint8Array): string {
    return ByteUtils.bytesToBase64Url(bytes);
}

export function base64UrlDecode(value: string): Uint8Array {
    return ByteUtils.base64UrlToBytes(value);
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

// --- Multi-algorithm support, for signing with keys Keetar didn't generate itself. ---

export function pemToPkcs8(pem: string): Uint8Array {
    const base64 = pem.replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
    return ByteUtils.base64ToBytes(base64);
}

export function pkcs8ToPem(bytes: Uint8Array): string {
    const base64 = ByteUtils.bytesToBase64(bytes);
    const lines: string[] = [];
    for (let i = 0; i < base64.length; i += 64) {
        lines.push(base64.slice(i, i + 64));
    }
    return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`;
}

function readDerLength(bytes: Uint8Array, pos: number): { length: number; next: number } {
    const first = bytes[pos];
    if ((first & 0x80) === 0) {
        return { length: first, next: pos + 1 };
    }
    const numBytes = first & 0x7f;
    let length = 0;
    for (let i = 0; i < numBytes; i++) {
        length = (length << 8) | bytes[pos + 1 + i];
    }
    return { length, next: pos + 1 + numBytes };
}

function readDerTlv(bytes: Uint8Array, pos: number): { tag: number; value: Uint8Array; next: number } {
    const tag = bytes[pos];
    const { length, next } = readDerLength(bytes, pos + 1);
    return { tag, value: bytes.slice(next, next + length), next: next + length };
}

function decodeOid(bytes: Uint8Array): string {
    const parts: number[] = [Math.floor(bytes[0] / 40), bytes[0] % 40];
    let value = 0;
    for (let i = 1; i < bytes.length; i++) {
        value = (value << 7) | (bytes[i] & 0x7f);
        if ((bytes[i] & 0x80) === 0) {
            parts.push(value);
            value = 0;
        }
    }
    return parts.join('.');
}

const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1';
const OID_ED25519 = '1.3.101.112';

// PKCS8 stores no algorithm field callers can just read — this sniffs PrivateKeyInfo's
// AlgorithmIdentifier OID instead, needed for keys Keetar didn't generate (no COSE alg to consult).
export function detectPkcs8Algorithm(pkcs8: Uint8Array): PasskeyAlgorithm {
    const outer = readDerTlv(pkcs8, 0);
    if (outer.tag !== 0x30) {
        throw new Error('not a valid PKCS8 private key: expected SEQUENCE');
    }
    const version = readDerTlv(outer.value, 0);
    const algIdSeq = readDerTlv(outer.value, version.next);
    if (algIdSeq.tag !== 0x30) {
        throw new Error('not a valid PKCS8 private key: expected AlgorithmIdentifier SEQUENCE');
    }
    const oidTlv = readDerTlv(algIdSeq.value, 0);
    if (oidTlv.tag !== 0x06) {
        throw new Error('not a valid PKCS8 private key: expected algorithm OID');
    }
    const oid = decodeOid(oidTlv.value);
    switch (oid) {
        case OID_RSA_ENCRYPTION:
            return 'RS256';
        case OID_EC_PUBLIC_KEY:
            return 'ES256';
        case OID_ED25519:
            return 'EdDSA';
        default:
            throw new Error(`unsupported PKCS8 key algorithm OID: ${oid}`);
    }
}

function algorithmImportParams(algorithm: PasskeyAlgorithm): EcKeyImportParams | RsaHashedImportParams | Algorithm {
    switch (algorithm) {
        case 'ES256':
            return { name: 'ECDSA', namedCurve: 'P-256' };
        case 'RS256':
            return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
        case 'EdDSA':
            return { name: 'Ed25519' };
    }
}

export async function importAnyPrivateKey(pkcs8: Uint8Array, algorithm: PasskeyAlgorithm): Promise<CryptoKey> {
    return crypto.subtle.importKey('pkcs8', toArrayBuffer(pkcs8), algorithmImportParams(algorithm), false, ['sign']);
}

// ES256 signatures need the raw-to-DER conversion signWithDer already does; RS256/EdDSA
// signatures from WebCrypto are already in their final WebAuthn-ready form.
export async function signAssertion(privateKey: CryptoKey, algorithm: PasskeyAlgorithm, data: Uint8Array): Promise<Uint8Array> {
    if (algorithm === 'ES256') {
        return signWithDer(privateKey, data);
    }
    const signParams = algorithm === 'RS256' ? { name: 'RSASSA-PKCS1-v1_5' } : { name: 'Ed25519' };
    return new Uint8Array(await crypto.subtle.sign(signParams, privateKey, toArrayBuffer(data)));
}
