import { describe, expect, test } from 'vitest';
import { hasCompleteCapturedLogin, mergeCapturedLogin } from '../../src/background/login-capture';

describe('captured login merging', () => {
    test('combines username and password submitted on separate pages', () => {
        const usernameStep = { title: 'Sign in', url: 'https://example.com/login', username: 'alice' };
        const passwordStep = { title: 'Enter password', url: 'https://example.com/password', password: 'secret' };
        const captured = mergeCapturedLogin(usernameStep, passwordStep);

        expect(captured).toEqual({
            title: 'Sign in',
            url: 'https://example.com/login',
            username: 'alice',
            password: 'secret'
        });
        expect(hasCompleteCapturedLogin(captured)).toBe(true);
    });

    test('does not consider a username-only step ready to save', () => {
        expect(hasCompleteCapturedLogin({ title: 'Sign in', url: 'https://example.com/login', username: 'alice' })).toBe(
            false
        );
    });
});
