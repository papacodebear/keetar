import { useState } from 'react';
import { sendToBackground } from '../../background/message-bus';
import type { EntryCustomField } from '../../background/vault-session';

export function CustomFieldsSection({
    entryUuid,
    customFields,
    onChanged
}: {
    entryUuid: string;
    customFields: EntryCustomField[];
    onChanged: () => void;
}) {
    const [revealed, setRevealed] = useState<Set<string>>(new Set());
    const [newName, setNewName] = useState('');
    const [newValue, setNewValue] = useState('');
    const [newProtected, setNewProtected] = useState(true);
    const [error, setError] = useState<string | undefined>(undefined);

    function toggleRevealed(name: string): void {
        setRevealed((prev) => {
            const next = new Set(prev);
            next.has(name) ? next.delete(name) : next.add(name);
            return next;
        });
    }

    async function rename(oldName: string, newFieldName: string): Promise<void> {
        if (!newFieldName || newFieldName === oldName) {
            return;
        }
        const response = await sendToBackground({ type: 'RENAME_CUSTOM_FIELD', entryUuid, oldName, newName: newFieldName });
        setError(response.ok ? undefined : response.error);
        onChanged();
    }

    async function setValueOrProtection(name: string, value: string, protect: boolean): Promise<void> {
        const response = await sendToBackground({ type: 'SET_CUSTOM_FIELD', entryUuid, name, value, protect });
        setError(response.ok ? undefined : response.error);
        onChanged();
    }

    async function remove(name: string): Promise<void> {
        await sendToBackground({ type: 'REMOVE_CUSTOM_FIELD', entryUuid, name });
        onChanged();
    }

    async function addField(): Promise<void> {
        const response = await sendToBackground({
            type: 'SET_CUSTOM_FIELD',
            entryUuid,
            name: newName,
            value: newValue,
            protect: newProtected
        });
        if (!response.ok) {
            setError(response.error);
            return;
        }
        setError(undefined);
        setNewName('');
        setNewValue('');
        setNewProtected(true);
        onChanged();
    }

    return (
        <div className="custom-fields">
            <label>Custom Fields</label>
            {error && <p className="entry-row-username">{error}</p>}
            {customFields.map((field) => (
                <div className="attachment-row" key={field.name}>
                    <input
                        type="text"
                        defaultValue={field.name}
                        onBlur={(e) => void rename(field.name, e.target.value.trim())}
                    />
                    <input
                        type={field.protected && !revealed.has(field.name) ? 'password' : 'text'}
                        defaultValue={field.value}
                        onBlur={(e) => void setValueOrProtection(field.name, e.target.value, field.protected)}
                    />
                    <label>
                        <input
                            type="checkbox"
                            checked={field.protected}
                            onChange={(e) => void setValueOrProtection(field.name, field.value, e.target.checked)}
                        />
                        Protected
                    </label>
                    <button type="button" onClick={() => toggleRevealed(field.name)}>
                        {revealed.has(field.name) ? 'Hide' : 'Show'}
                    </button>
                    <button type="button" className="danger" onClick={() => void remove(field.name)}>
                        Remove
                    </button>
                </div>
            ))}
            <div className="attachment-row">
                <input type="text" placeholder="Field name" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <input
                    type={newProtected ? 'password' : 'text'}
                    placeholder="Value"
                    value={newValue}
                    onChange={(e) => setNewValue(e.target.value)}
                />
                <label>
                    <input type="checkbox" checked={newProtected} onChange={(e) => setNewProtected(e.target.checked)} />
                    Protected
                </label>
                <button type="button" disabled={!newName.trim()} onClick={() => void addField()}>
                    Add field
                </button>
            </div>
        </div>
    );
}
