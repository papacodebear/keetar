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
            password: 'secret',
            passwordCandidates: []
        });
        expect(hasCompleteCapturedLogin(captured)).toBe(true);
    });

    test('does not consider a username-only step ready to save', () => {
        expect(hasCompleteCapturedLogin({ title: 'Sign in', url: 'https://example.com/login', username: 'alice' })).toBe(
            false
        );
    });

    test('unions passwordCandidates across merge steps', () => {
        const first = { title: 'Change password', url: 'https://example.com/change', passwordCandidates: ['old-pw'] };
        const second = { title: 'Change password', url: 'https://example.com/change', passwordCandidates: ['new-pw', 'new-pw'] };
        const merged = mergeCapturedLogin(first, second);

        expect(merged.passwordCandidates).toEqual(['old-pw', 'new-pw', 'new-pw']);
    });

    test('treats a capture with no passwordCandidates as an empty list after merging', () => {
        const merged = mergeCapturedLogin(undefined, { title: 'Sign in', url: 'https://example.com/login', username: 'alice' });

        expect(merged.passwordCandidates).toEqual([]);
    });
});
