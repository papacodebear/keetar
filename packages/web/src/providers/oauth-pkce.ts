import { ByteUtils } from '@keetar/core';
import { identity } from '../platform';

// Generic OAuth2 PKCE (provider-agnostic §7.3 plumbing)—no client secret; code_verifier/code_challenge replaces shared secret.
export interface PkceProviderConfig {
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    scopes: string[];
    /** Provider-specific extras merged into the authorization request — e.g. Google's access_type=offline. */
    extraAuthParams?: Record<string, string>;
}

export interface OAuthTokens {
    accessToken: string;
    /** Undefined on a refresh response that didn't include a new one — the caller keeps the previous refresh token in that case. */
    refreshToken: string | undefined;
    /** Epoch milliseconds. */
    expiresAt: number;
}

function base64UrlEncode(bytes: Uint8Array): string {
    return ByteUtils.bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodeVerifier(): string {
    return base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export async function generateCodeChallenge(verifier: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', ByteUtils.stringToBytes(verifier));
    return base64UrlEncode(new Uint8Array(digest));
}

function generateState(): string {
    return base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

// Opens consent screen via launchWebAuthFlow, exchanges code for tokens; throws on cancel/error/state mismatch (CSRF guard).
export async function authorize(config: PkceProviderConfig): Promise<OAuthTokens> {
    const redirectUri = identity.getRedirectURL();
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const state = generateState();

    const authUrl = new URL(config.authorizeUrl);
    authUrl.searchParams.set('client_id', config.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', config.scopes.join(' '));
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    for (const [key, value] of Object.entries(config.extraAuthParams ?? {})) {
        authUrl.searchParams.set(key, value);
    }

    let resultUrl: string | undefined;
    try {
        resultUrl = await identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true });
    } catch (e) {
        throw new Error(e instanceof Error ? e.message : 'authorization was cancelled');
    }
    if (!resultUrl) {
        throw new Error('authorization was cancelled');
    }

    const params = new URL(resultUrl).searchParams;
    if (params.get('state') !== state) {
        throw new Error('OAuth state mismatch — possible response injection, aborting');
    }
    const code = params.get('code');
    if (!code) {
        throw new Error(params.get('error_description') ?? params.get('error') ?? 'authorization failed');
    }

    return requestTokens(
        config.tokenUrl,
        new URLSearchParams({
            client_id: config.clientId,
            code,
            code_verifier: verifier,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri
        })
    );
}

export async function refreshAccessToken(config: PkceProviderConfig, refreshToken: string): Promise<OAuthTokens> {
    return requestTokens(
        config.tokenUrl,
        new URLSearchParams({
            client_id: config.clientId,
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        })
    );
}

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
}

async function requestTokens(tokenUrl: string, body: URLSearchParams): Promise<OAuthTokens> {
    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
    });
    if (!response.ok) {
        throw new Error(`OAuth token request failed: ${response.status}`);
    }
    const json = (await response.json()) as TokenResponse;
    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        expiresAt: Date.now() + json.expires_in * 1000
    };
}
