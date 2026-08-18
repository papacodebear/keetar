import { useEffect, useState } from 'react';
import { sendToBackground, type PendingPasskeyRequest } from '../../background/message-bus';
import { ErrorBox } from '../shared/ErrorBox';
import { getConfiguredVault, type VaultBackend } from '../../config/vault-config';
import { ensureVaultFilePermission } from '../../providers/local-file';
import type { PromptToRelayMessage } from '../../passkey-provider/bridge-protocol';

interface CandidateOption {
    id: string; // entryUuid (create) or credentialId (get)
    label: string;
    entryUuid: string;
}

type ViewState =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'locked'; vaultUuid: string; vaultName: string; vaultProvider: VaultBackend; error?: string }
    | {
          kind: 'confirm';
          request: PendingPasskeyRequest;
          candidates: CandidateOption[];
          selected: string | undefined;
          createNew: boolean;
          busy: boolean;
          error?: string;
      };

function requestIdFromUrl(): string {
    return new URLSearchParams(window.location.search).get('requestId') ?? '';
}

function postResult(origin: string, message: Omit<PromptToRelayMessage, 'source' | 'requestId'>): void {
    const requestId = requestIdFromUrl();
    window.parent.postMessage({ source: 'keetar-passkey-prompt', requestId, ...message }, origin);
}

export function App() {
    const [view, setView] = useState<ViewState>({ kind: 'loading' });

    useEffect(() => {
        void load();
    }, []);

    async function load(): Promise<void> {
        const requestId = requestIdFromUrl();
        const requestResponse = await sendToBackground({ type: 'GET_PASSKEY_REQUEST', requestId });
        if (!requestResponse.ok || requestResponse.type !== 'GET_PASSKEY_REQUEST' || !requestResponse.request) {
            setView({ kind: 'error', message: 'This passkey request has expired.' });
            return;
        }
        const request = requestResponse.request;

        const configured = await getConfiguredVault();
        if (!configured) {
            setView({ kind: 'error', message: 'No vault is configured.' });
            return;
        }
        const status = await sendToBackground({ type: 'GET_STATUS' });
        if (!status.ok) {
            setView({ kind: 'error', message: status.error });
            return;
        }
        if (status.type === 'GET_STATUS' && status.status !== 'unlocked') {
            setView({ kind: 'locked', vaultUuid: configured.uuid, vaultName: configured.name, vaultProvider: configured.provider });
            return;
        }
        await loadCandidates(request);
    }

    async function loadCandidates(request: PendingPasskeyRequest): Promise<void> {
        if (request.kind === 'get') {
            const response = await sendToBackground({
                type: 'LIST_PASSKEYS_FOR_RPID',
                rpId: request.rpId,
                allowCredentialIds: request.get?.allowCredentialIds
            });
            if (!response.ok || response.type !== 'LIST_PASSKEYS_FOR_RPID') {
                setView({ kind: 'error', message: !response.ok ? response.error : 'Could not load passkeys.' });
                return;
            }
            if (response.passkeys.length === 0) {
                setView({ kind: 'error', message: `No Keetar passkey found for ${request.rpId}.` });
                return;
            }
            const candidates = response.passkeys.map((p) => ({
                id: p.credentialId,
                label: p.entryTitle || request.rpId,
                entryUuid: p.entryUuid
            }));
            setView({
                kind: 'confirm',
                request,
                candidates,
                selected: candidates[0].id,
                createNew: false,
                busy: false
            });
            return;
        }

        const [entriesResponse, matchResponse] = await Promise.all([
            sendToBackground({ type: 'LIST_ENTRIES' }),
            sendToBackground({ type: 'MATCH_ENTRIES', tabUrl: `https://${request.rpId}` })
        ]);
        const entries = entriesResponse.ok && entriesResponse.type === 'LIST_ENTRIES' ? entriesResponse.entries : [];
        const matchedUuids =
            matchResponse.ok && matchResponse.type === 'MATCH_ENTRIES' ? new Set(matchResponse.matches.map((m) => m.uuid)) : new Set<string>();
        const candidates = entries
            .filter((e) => matchedUuids.has(e.uuid))
            .map((e) => ({ id: e.uuid, label: e.title || request.rpId, entryUuid: e.uuid }));
        setView({
            kind: 'confirm',
            request,
            candidates,
            selected: candidates[0]?.id,
            createNew: candidates.length === 0,
            busy: false
        });
    }

    async function unlock(vaultUuid: string, vaultName: string, vaultProvider: VaultBackend, password: string): Promise<void> {
        try {
            if (vaultProvider === 'local-file') {
                await ensureVaultFilePermission(vaultUuid);
            }
            const response = await sendToBackground({ type: 'UNLOCK_VAULT', uuid: vaultUuid, password });
            if (!response.ok) {
                setView({ kind: 'locked', vaultUuid, vaultName, vaultProvider, error: response.error });
                return;
            }
            const requestResponse = await sendToBackground({ type: 'GET_PASSKEY_REQUEST', requestId: requestIdFromUrl() });
            if (!requestResponse.ok || requestResponse.type !== 'GET_PASSKEY_REQUEST' || !requestResponse.request) {
                setView({ kind: 'error', message: 'This passkey request has expired.' });
                return;
            }
            await loadCandidates(requestResponse.request);
        } catch (e) {
            setView({ kind: 'locked', vaultUuid, vaultName, vaultProvider, error: e instanceof Error ? e.message : String(e) });
        }
    }

    async function confirm(state: Extract<ViewState, { kind: 'confirm' }>): Promise<void> {
        setView({ ...state, busy: true, error: undefined });
        const { request } = state;
        if (request.kind === 'create') {
            const response = await sendToBackground({
                type: 'CREATE_PASSKEY',
                rpId: request.rpId,
                origin: request.origin,
                userName: request.create?.userName ?? '',
                userHandleBase64Url: request.create?.userHandleBase64Url ?? '',
                userDisplayName: request.create?.userDisplayName,
                entryUuid: state.createNew ? undefined : state.selected,
                createNewEntry: state.createNew
            });
            if (!response.ok || response.type !== 'CREATE_PASSKEY') {
                setView({ ...state, busy: false, error: !response.ok ? response.error : 'Could not create the passkey.' });
                return;
            }
            postResult(request.origin, {
                ok: true,
                create: { credentialIdBase64Url: response.credentialId, attestationObjectBase64: response.attestationObjectBase64 }
            });
            return;
        }
        const chosen = state.candidates.find((c) => c.id === state.selected);
        if (!chosen) {
            setView({ ...state, busy: false, error: 'Choose a passkey.' });
            return;
        }
        const response = await sendToBackground({
            type: 'SIGN_PASSKEY_ASSERTION',
            entryUuid: chosen.entryUuid,
            credentialId: chosen.id,
            rpId: request.rpId,
            origin: request.origin,
            challengeBase64: request.challengeBase64
        });
        if (!response.ok || response.type !== 'SIGN_PASSKEY_ASSERTION') {
            setView({ ...state, busy: false, error: !response.ok ? response.error : 'Could not sign in.' });
            return;
        }
        postResult(request.origin, {
            ok: true,
            get: {
                credentialIdBase64Url: chosen.id,
                authenticatorDataBase64: response.authenticatorDataBase64,
                signatureBase64: response.signatureBase64,
                userHandleBase64Url: response.userHandleBase64Url
            }
        });
    }

    if (view.kind === 'loading') {
        return <p>Loading…</p>;
    }
    if (view.kind === 'error') {
        return <ErrorBox message={view.message} />;
    }
    if (view.kind === 'locked') {
        return (
            <UnlockForm
                vaultName={view.vaultName}
                error={view.error}
                onUnlock={(password) => void unlock(view.vaultUuid, view.vaultName, view.vaultProvider, password)}
            />
        );
    }

    const { request } = view;
    return (
        <div className="panel">
            <h1>{request.kind === 'create' ? 'Create a passkey with Keetar' : 'Sign in with a Keetar passkey'}</h1>
            <p className="rp-id">{request.rpId}</p>
            {request.kind === 'create' && view.candidates.length > 0 && (
                <div className="candidates">
                    <label>
                        <input
                            type="radio"
                            checked={!view.createNew}
                            onChange={() => setView({ ...view, createNew: false })}
                        />
                        Attach to an existing entry
                    </label>
                    {!view.createNew && (
                        <select value={view.selected} onChange={(e) => setView({ ...view, selected: e.target.value })}>
                            {view.candidates.map((c) => (
                                <option key={c.id} value={c.id}>
                                    {c.label}
                                </option>
                            ))}
                        </select>
                    )}
                    <label>
                        <input type="radio" checked={view.createNew} onChange={() => setView({ ...view, createNew: true })} />
                        Create a new entry
                    </label>
                </div>
            )}
            {request.kind === 'get' && view.candidates.length > 1 && (
                <select value={view.selected} onChange={(e) => setView({ ...view, selected: e.target.value })}>
                    {view.candidates.map((c) => (
                        <option key={c.id} value={c.id}>
                            {c.label}
                        </option>
                    ))}
                </select>
            )}
            {view.error && <ErrorBox message={view.error} />}
            <div className="actions">
                <button type="button" disabled={view.busy} onClick={() => postResult(request.origin, { ok: false, error: 'cancelled' })}>
                    Cancel
                </button>
                <button type="button" disabled={view.busy} onClick={() => void confirm(view)}>
                    {view.busy ? 'Working…' : 'Continue'}
                </button>
            </div>
        </div>
    );
}

function UnlockForm({
    vaultName,
    error,
    onUnlock
}: {
    vaultName: string;
    error: string | undefined;
    onUnlock: (password: string) => void;
}) {
    const [password, setPassword] = useState('');
    return (
        <form
            className="panel"
            onSubmit={(e) => {
                e.preventDefault();
                onUnlock(password);
            }}
        >
            <h1>Unlock {vaultName}</h1>
            <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
            {error && <ErrorBox message={error} />}
            <button type="submit">Unlock</button>
        </form>
    );
}
