import { describe, expect, test } from 'vitest';
import { generatePassphrase } from '../../src/generator/passphrase.js';
import { EFF_LARGE_WORDLIST } from '../../src/generator/eff-large-wordlist.js';

const WordSet = new Set(EFF_LARGE_WORDLIST);

describe('EFF_LARGE_WORDLIST', () => {
    test('has exactly 7776 unique, lowercase words', () => {
        expect(EFF_LARGE_WORDLIST.length).toBe(7776);
        expect(WordSet.size).toBe(7776);
        for (const word of EFF_LARGE_WORDLIST) {
            expect(word).toBe(word.toLowerCase());
        }
    });
});

describe('generatePassphrase', () => {
    test('produces the requested number of words', () => {
        for (const wordCount of [1, 3, 6, 10]) {
            const passphrase = generatePassphrase({ wordCount, capitalize: false });
            expect(passphrase.split('-').length).toBe(wordCount);
        }
    });

    test('every generated word is drawn from the EFF wordlist', () => {
        const passphrase = generatePassphrase({ wordCount: 50, capitalize: false });
        for (const word of passphrase.split('-')) {
            expect(WordSet.has(word)).toBe(true);
        }
    });

    test('applies the configured separator', () => {
        const passphrase = generatePassphrase({ wordCount: 4, separator: ' ', capitalize: false });
        expect(passphrase.split(' ').length).toBe(4);
        expect(passphrase).not.toContain('-');
    });

    test('capitalize defaults to true, capitalizing every word', () => {
        const passphrase = generatePassphrase({ wordCount: 5 });
        for (const word of passphrase.split('-')) {
            const bareWord = word.replace(/[0-9]/g, '');
            expect(bareWord.charAt(0)).toBe(bareWord.charAt(0).toUpperCase());
            expect(bareWord.slice(1)).toBe(bareWord.slice(1).toLowerCase());
        }
    });

    test('includeNumber appends a digit to exactly one word', () => {
        const passphrase = generatePassphrase({ wordCount: 6, separator: '-', capitalize: false, includeNumber: true });
        const words = passphrase.split('-');
        expect(words.length).toBe(6);
        const digitWords = words.filter((word) => /[0-9]$/.test(word));
        expect(digitWords.length).toBe(1);
    });

    test('defaults to 6 words with a hyphen separator', () => {
        const passphrase = generatePassphrase();
        expect(passphrase.split('-').length).toBe(6);
    });

    test('throws when wordCount is less than 1', () => {
        expect(() => generatePassphrase({ wordCount: 0 })).toThrow();
    });

    test('generates different output across calls', () => {
        const passphrases = new Set(Array.from({ length: 20 }, () => generatePassphrase({ wordCount: 8 })));
        expect(passphrases.size).toBe(20);
    });
});
