import { useEffect, useState } from 'react';
import { sendToBackground } from '../../background/message-bus';
import type { PasskeySummary } from '../../background/vault-session';

export function PasskeySection({ entryUuid, onChanged }: { entryUuid: string; onChanged: () => void }) {
    const [passkeys, setPasskeys] = useState<PasskeySummary[]>([]);

    async function load(): Promise<void> {
        const response = await sendToBackground({ type: 'LIST_PASSKEYS_FOR_ENTRY', entryUuid });
        setPasskeys(response.ok && response.type === 'LIST_PASSKEYS_FOR_ENTRY' ? response.passkeys : []);
    }

    useEffect(() => {
        void load();
    }, [entryUuid]);

    async function remove(credentialId: string): Promise<void> {
        await sendToBackground({ type: 'REMOVE_PASSKEY', entryUuid, credentialId });
        await load();
        onChanged();
    }

    if (passkeys.length === 0) {
        return null;
    }

    return (
        <div className="detail-section">
            <label>Passkeys</label>
            {passkeys.map((passkey) => (
                <div className="attachment-row" key={passkey.credentialId}>
                    <span>{passkey.rpId}</span>
                    <button type="button" className="danger" onClick={() => void remove(passkey.credentialId)}>
                        Remove
                    </button>
                </div>
            ))}
        </div>
    );
}
