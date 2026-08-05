export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpConfig {
    secret: string;
    algorithm: TotpAlgorithm;
    digits: number;
    period: number;
}

export interface TotpCode {
    code: string;
    remainingSeconds: number;
}

const DEFAULT_PERIOD = 30;
const DEFAULT_DIGITS = 6;
const DEFAULT_ALGORITHM: TotpAlgorithm = 'SHA1';
const VALID_ALGORITHMS = new Set<TotpAlgorithm>(['SHA1', 'SHA256', 'SHA512']);
const VALID_DIGITS = new Set([6, 7, 8]);

export function parseTotp(value: string): TotpConfig {
    if (!value.trim()) {
        throw new Error('TOTP secret is required');
    }
    if (!value.toLowerCase().startsWith('otpauth:')) {
        return createConfig(value, DEFAULT_ALGORITHM, DEFAULT_DIGITS, DEFAULT_PERIOD);
    }

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('invalid TOTP URL');
    }
    if (url.protocol !== 'otpauth:' || url.hostname.toLowerCase() !== 'totp') {
        throw new Error('unsupported OTP type');
    }

    return createConfig(
        url.searchParams.get('secret') ?? '',
        parseAlgorithm(url.searchParams.get('algorithm')),
        parsePositiveInteger(url.searchParams.get('digits'), DEFAULT_DIGITS, 'digits'),
        parsePositiveInteger(url.searchParams.get('period'), DEFAULT_PERIOD, 'period')
    );
}

export async function generateTotpCode(value: string, now = Date.now()): Promise<TotpCode> {
    if (!Number.isFinite(now) || now < 0) {
        throw new Error('invalid TOTP timestamp');
    }
    const config = parseTotp(value);
    const counter = BigInt(Math.floor(now / 1_000 / config.period));
    const message = new ArrayBuffer(8);
    new DataView(message).setBigUint64(0, counter);

    const algorithm = { name: 'HMAC', hash: `SHA-${config.algorithm.slice(3)}` };
    const key = await globalThis.crypto.subtle.importKey(
        'raw',
        base32ToBytes(config.secret),
        algorithm,
        false,
        ['sign']
    );
    const mac = new Uint8Array(await globalThis.crypto.subtle.sign(algorithm, key, message));
    const offset = mac[mac.length - 1] & 0x0f;
    const binary = new DataView(mac.buffer, mac.byteOffset, mac.byteLength).getUint32(offset) & 0x7fffffff;
    const code = String(binary % 10 ** config.digits).padStart(config.digits, '0');
    const elapsedSeconds = Math.floor(now / 1_000) % config.period;
    return { code, remainingSeconds: config.period - elapsedSeconds };
}

function createConfig(
    secret: string,
    algorithm: TotpAlgorithm,
    digits: number,
    period: number
): TotpConfig {
    base32ToBytes(secret);
    if (!VALID_ALGORITHMS.has(algorithm)) {
        throw new Error(`unsupported TOTP algorithm: ${algorithm}`);
    }
    if (!VALID_DIGITS.has(digits)) {
        throw new Error(`unsupported TOTP digits: ${digits}`);
    }
    if (!Number.isInteger(period) || period < 1) {
        throw new Error(`invalid TOTP period: ${period}`);
    }
    return { secret, algorithm, digits, period };
}

function parseAlgorithm(value: string | null): TotpAlgorithm {
    const algorithm = (value ?? DEFAULT_ALGORITHM).toUpperCase() as TotpAlgorithm;
    if (!VALID_ALGORITHMS.has(algorithm)) {
        throw new Error(`unsupported TOTP algorithm: ${value}`);
    }
    return algorithm;
}

function parsePositiveInteger(value: string | null, fallback: number, name: string): number {
    if (value === null || value === '') {
        return fallback;
    }
    if (!/^\d+$/.test(value)) {
        throw new Error(`invalid TOTP ${name}: ${value}`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`invalid TOTP ${name}: ${value}`);
    }
    return parsed;
}

function base32ToBytes(value: string): Uint8Array<ArrayBuffer> {
    const normalized = value.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
    if (!normalized || !/^[A-Z2-7]+$/.test(normalized)) {
        throw new Error('invalid TOTP secret');
    }

    const bytes = new Uint8Array(Math.floor((normalized.length * 5) / 8));
    let buffer = 0;
    let bitCount = 0;
    let outputIndex = 0;
    for (const char of normalized) {
        buffer = (buffer << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);
        bitCount += 5;
        while (bitCount >= 8) {
            bitCount -= 8;
            bytes[outputIndex++] = (buffer >>> bitCount) & 0xff;
        }
    }
    return bytes;
}