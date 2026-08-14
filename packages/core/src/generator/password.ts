import { secureRandomInt } from './secure-random-int.js';

export interface PasswordGeneratorOptions {
    length: number;
    useLowercase?: boolean;
    useUppercase?: boolean;
    useDigits?: boolean;
    useSymbols?: boolean;
    excludeAmbiguous?: boolean;
    /** Overrides the built-in symbol pool when useSymbols is on; blank/unset falls back to DefaultSymbolCharacters. */
    symbols?: string;
}

const Lowercase = 'abcdefghijklmnopqrstuvwxyz';
const Uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const Digits = '0123456789';
export const DefaultSymbolCharacters = '!@#$%^&*()-_=+[]{};:,.<>/?';
const AmbiguousChars = new Set(['0', 'O', '1', 'l', 'I', '|']);

const DefaultOptions: PasswordGeneratorOptions = {
    length: 20,
    useLowercase: true,
    useUppercase: true,
    useDigits: true,
    useSymbols: true,
    excludeAmbiguous: false
};

// Rejection-sampling cap for the "at least one char per selected class" retry loop below.
const MaxAttempts = 1000;

export function generatePassword(options?: Partial<PasswordGeneratorOptions>): string {
    const opts: PasswordGeneratorOptions = { ...DefaultOptions, ...options };
    if (opts.length < 1) {
        throw new Error('Password length must be at least 1');
    }

    const classes = buildCharacterClasses(opts);
    if (classes.length === 0) {
        throw new Error('At least one character class must be selected');
    }
    if (classes.length > 1 && opts.length < classes.length) {
        throw new Error(
            `Password length must be at least ${classes.length} to include a character from every selected class`
        );
    }

    const pool = classes.join('');

    for (let attempt = 0; attempt < MaxAttempts; attempt++) {
        const candidate = drawFromPool(pool, opts.length);
        if (classes.length === 1 || containsEachClass(candidate, classes)) {
            return candidate;
        }
    }
    throw new Error('Failed to generate a password satisfying the selected character classes');
}

function buildCharacterClasses(opts: PasswordGeneratorOptions): string[] {
    const classes: string[] = [];
    if (opts.useLowercase) {
        classes.push(filterAmbiguous(Lowercase, opts.excludeAmbiguous));
    }
    if (opts.useUppercase) {
        classes.push(filterAmbiguous(Uppercase, opts.excludeAmbiguous));
    }
    if (opts.useDigits) {
        classes.push(filterAmbiguous(Digits, opts.excludeAmbiguous));
    }
    if (opts.useSymbols) {
        const pool = opts.symbols?.trim() ? dedupe(opts.symbols) : DefaultSymbolCharacters;
        classes.push(filterAmbiguous(pool, opts.excludeAmbiguous));
    }
    return classes.filter((cls) => cls.length > 0);
}

function filterAmbiguous(chars: string, exclude?: boolean): string {
    if (!exclude) {
        return chars;
    }
    return Array.from(chars)
        .filter((c) => !AmbiguousChars.has(c))
        .join('');
}

// Dedupe custom symbols — repeats would bias secureRandomInt toward them.
function dedupe(chars: string): string {
    return Array.from(new Set(chars)).join('');
}

function drawFromPool(pool: string, length: number): string {
    let result = '';
    for (let i = 0; i < length; i++) {
        result += pool[secureRandomInt(pool.length)];
    }
    return result;
}

function containsEachClass(candidate: string, classes: string[]): boolean {
    return classes.every((cls) => Array.from(candidate).some((c) => cls.includes(c)));
}
