import { describe, expect, test } from 'vitest';
import { generatePassword, DefaultSymbolCharacters } from '../../src/generator/password.js';

const Lowercase = /[a-z]/;
const Uppercase = /[A-Z]/;
const Digits = /[0-9]/;
const Symbols = /[!@#$%^&*()\-_=+[\]{};:,.<>/?]/;
const AmbiguousChars = ['0', 'O', '1', 'l', 'I', '|'];

describe('generatePassword', () => {
    test('produces output matching the requested length', () => {
        for (const length of [4, 8, 20, 64, 128]) {
            expect(generatePassword({ length }).length).toBe(length);
        }
    });

    test('produces output matching the requested length with a single class', () => {
        for (const length of [1, 8, 20]) {
            expect(
                generatePassword({
                    length,
                    useLowercase: true,
                    useUppercase: false,
                    useDigits: false,
                    useSymbols: false
                }).length
            ).toBe(length);
        }
    });

    test('draws only from the digits class when it is the only one selected', () => {
        for (let i = 0; i < 20; i++) {
            const password = generatePassword({
                length: 30,
                useLowercase: false,
                useUppercase: false,
                useDigits: true,
                useSymbols: false
            });
            expect(password).toMatch(/^[0-9]+$/);
        }
    });

    test('draws only from the lowercase class when it is the only one selected', () => {
        const password = generatePassword({
            length: 30,
            useLowercase: true,
            useUppercase: false,
            useDigits: false,
            useSymbols: false
        });
        expect(password).toMatch(/^[a-z]+$/);
    });

    test('includes at least one character from every selected class', () => {
        for (let i = 0; i < 200; i++) {
            const password = generatePassword({
                length: 12,
                useLowercase: true,
                useUppercase: true,
                useDigits: true,
                useSymbols: true
            });
            expect(password).toMatch(Lowercase);
            expect(password).toMatch(Uppercase);
            expect(password).toMatch(Digits);
            expect(password).toMatch(Symbols);
        }
    });

    test('excludeAmbiguous strips visually-confusable characters from the pool', () => {
        for (let i = 0; i < 50; i++) {
            const password = generatePassword({
                length: 40,
                useLowercase: true,
                useUppercase: true,
                useDigits: true,
                useSymbols: false,
                excludeAmbiguous: true
            });
            for (const ambiguous of AmbiguousChars) {
                expect(password).not.toContain(ambiguous);
            }
        }
    });

    test('a custom symbol set restricts the pool to exactly those characters', () => {
        for (let i = 0; i < 20; i++) {
            const password = generatePassword({
                length: 30,
                useLowercase: false,
                useUppercase: false,
                useDigits: false,
                useSymbols: true,
                symbols: '#$%'
            });
            expect(password).toMatch(/^[#$%]+$/);
        }
    });

    test('duplicate characters in a custom symbol set do not error and stay within that set', () => {
        const password = generatePassword({
            length: 30,
            useLowercase: false,
            useUppercase: false,
            useDigits: false,
            useSymbols: true,
            symbols: '##$$$%%%%'
        });
        expect(password).toMatch(/^[#$%]+$/);
    });

    test('a blank custom symbol set falls back to the default symbol characters', () => {
        const password = generatePassword({
            length: 40,
            useLowercase: false,
            useUppercase: false,
            useDigits: false,
            useSymbols: true,
            symbols: '   '
        });
        for (const char of password) {
            expect(DefaultSymbolCharacters).toContain(char);
        }
    });

    test('defaults to a 20-character password with every class enabled', () => {
        const password = generatePassword();
        expect(password.length).toBe(20);
    });

    test('throws when length is less than 1', () => {
        expect(() => generatePassword({ length: 0 })).toThrow();
    });

    test('throws when no character class is selected', () => {
        expect(() =>
            generatePassword({
                length: 10,
                useLowercase: false,
                useUppercase: false,
                useDigits: false,
                useSymbols: false
            })
        ).toThrow();
    });

    test('throws when length is too short to cover every selected class', () => {
        expect(() =>
            generatePassword({
                length: 2,
                useLowercase: true,
                useUppercase: true,
                useDigits: true,
                useSymbols: true
            })
        ).toThrow();
    });

    test('generates different output across calls', () => {
        const passwords = new Set(Array.from({ length: 20 }, () => generatePassword({ length: 20 })));
        expect(passwords.size).toBe(20);
    });
});
