// Minimal CBOR: definite-length maps, byte strings, text strings, small ints — enough for
// WebAuthn's attestationObject/COSE keys and our own passkey-attachment blobs, nothing more.

export type CborValue = number | string | Uint8Array | CborMap;
export type CborMap = Map<number | string, CborValue>;

const MAJOR_UINT = 0;
const MAJOR_NEGINT = 1;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_MAP = 5;

function encodeHead(major: number, argument: number): number[] {
    if (argument < 24) {
        return [(major << 5) | argument];
    }
    if (argument < 0x100) {
        return [(major << 5) | 24, argument];
    }
    if (argument < 0x10000) {
        return [(major << 5) | 25, (argument >> 8) & 0xff, argument & 0xff];
    }
    return [
        (major << 5) | 26,
        (argument >>> 24) & 0xff,
        (argument >>> 16) & 0xff,
        (argument >>> 8) & 0xff,
        argument & 0xff
    ];
}

function encodeInt(n: number): number[] {
    return n >= 0 ? encodeHead(MAJOR_UINT, n) : encodeHead(MAJOR_NEGINT, -1 - n);
}

function encodeBytes(bytes: Uint8Array): number[] {
    return [...encodeHead(MAJOR_BYTES, bytes.length), ...bytes];
}

function encodeText(text: string): number[] {
    const bytes = new TextEncoder().encode(text);
    return [...encodeHead(MAJOR_TEXT, bytes.length), ...bytes];
}

function encodeKey(key: number | string): number[] {
    return typeof key === 'number' ? encodeInt(key) : encodeText(key);
}

export function encodeCborValue(value: CborValue): Uint8Array {
    if (value instanceof Uint8Array) {
        return Uint8Array.from(encodeBytes(value));
    }
    if (typeof value === 'string') {
        return Uint8Array.from(encodeText(value));
    }
    if (typeof value === 'number') {
        return Uint8Array.from(encodeInt(value));
    }
    return encodeCborMap(value);
}

export function encodeCborMap(map: CborMap): Uint8Array {
    const parts: number[] = [...encodeHead(MAJOR_MAP, map.size)];
    for (const [key, value] of map) {
        parts.push(...encodeKey(key), ...encodeCborValue(value));
    }
    return Uint8Array.from(parts);
}

interface CborDecodeResult {
    value: CborValue;
    offset: number;
}

function decodeHead(bytes: Uint8Array, offset: number): { major: number; length: number; offset: number } {
    const first = bytes[offset];
    const major = first >> 5;
    const info = first & 0x1f;
    let pos = offset + 1;
    let length: number;
    if (info < 24) {
        length = info;
    } else if (info === 24) {
        length = bytes[pos];
        pos += 1;
    } else if (info === 25) {
        length = (bytes[pos] << 8) | bytes[pos + 1];
        pos += 2;
    } else if (info === 26) {
        length = ((bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
        pos += 4;
    } else {
        throw new Error(`unsupported CBOR length encoding: ${info}`);
    }
    return { major, length, offset: pos };
}

export function decodeCborValue(bytes: Uint8Array, offset = 0): CborDecodeResult {
    const { major, length, offset: pos } = decodeHead(bytes, offset);
    switch (major) {
        case MAJOR_UINT:
            return { value: length, offset: pos };
        case MAJOR_NEGINT:
            return { value: -1 - length, offset: pos };
        case MAJOR_BYTES:
            return { value: bytes.slice(pos, pos + length), offset: pos + length };
        case MAJOR_TEXT:
            return { value: new TextDecoder().decode(bytes.slice(pos, pos + length)), offset: pos + length };
        case MAJOR_MAP: {
            const map: CborMap = new Map();
            let cursor = pos;
            for (let i = 0; i < length; i++) {
                const key = decodeCborValue(bytes, cursor);
                const value = decodeCborValue(bytes, key.offset);
                if (typeof key.value !== 'string' && typeof key.value !== 'number') {
                    throw new Error('unsupported CBOR map key type');
                }
                map.set(key.value, value.value);
                cursor = value.offset;
            }
            return { value: map, offset: cursor };
        }
        default:
            throw new Error(`unsupported CBOR major type: ${major}`);
    }
}

export function decodeCborMap(bytes: Uint8Array): CborMap {
    const { value } = decodeCborValue(bytes, 0);
    if (!(value instanceof Map)) {
        throw new Error('expected a CBOR map at top level');
    }
    return value;
}
