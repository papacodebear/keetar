import { describe, test, expect } from 'vitest';
import { KdbxError } from '../../src';

describe('KdbxError', () => {
    test('creates error without message', () => {
        const err = new KdbxError('1');
        expect(err.name).toBe('KdbxError');
        expect(err.code).toBe('1');
        expect(err.message).toBe('Error 1');
        expect(err.toString()).toBe('KdbxError: Error 1');
    });

    test('creates error with message', () => {
        const err = new KdbxError('2', 'msg');
        expect(err.name).toBe('KdbxError');
        expect(err.code).toBe('2');
        expect(err.message).toBe('Error 2: msg');
        expect(err.toString()).toBe('KdbxError: Error 2: msg');
    });
});
