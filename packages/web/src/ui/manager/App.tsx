import { useEffect, useState } from 'react';
import { ByteUtils } from '@keetar/core';
import { sendToBackground } from '../../background/message-bus';
import type { EntryDetail, GroupNode } from '../../background/vault-session';

// Manager — full vault-content management, post-unlock only (§8.1). Owns
// entry create/edit/delete, group tree management, attachments (§8.2). Owns
// no settings, and never calls anything Options-flavored.
//
// Manager doesn't have its own unlock flow — it shares the background's
// session with Popup (§8.1), so if the vault happens to be locked when this
// page is opened, the only thing to do is point the user back at Popup.

type AppState =
    | { kind: 'loading' }
    | { kind: 'locked' }
    | { kind: 'ready'; root: GroupNode; selectedGroupUuid: string; selectedEntryUuid?: string };

export function App() {
    const [state, setState] = useState<AppState>({ kind: 'loading' });

    useEffect(() => {
        void init();
    }, []);

    async function init(): Promise<void> {
        const status = await sendToBackground({ type: 'GET_STATUS' });
        if (!status.ok || status.type !== 'GET_STATUS' || status.status !== 'unlocked') {
            setState({ kind: 'locked' });
            return;
        }
        await reloadTree();
    }

    async function reloadTree(keepSelection?: { groupUuid: string; entryUuid?: string }): Promise<void> {
        const response = await sendToBackground({ type: 'GET_GROUP_TREE' });
        if (!response.ok || response.type !== 'GET_GROUP_TREE') {
            setState({ kind: 'locked' });
            return;
        }
        setState({
            kind: 'ready',
            root: response.root,
            selectedGroupUuid: keepSelection?.groupUuid ?? response.root.uuid,
            selectedEntryUuid: keepSelection?.entryUuid
        });
    }

    if (state.kind === 'loading') {
        return <p style={{ padding: '1rem' }}>Loading…</p>;
    }
    if (state.kind === 'locked') {
        return (
            <div className="empty-state">
                <p>The vault is locked.</p>
                <p>Unlock it from the extension's popup, then reopen this tab.</p>
            </div>
        );
    }

    return (
        <Ready
            root={state.root}
            selectedGroupUuid={state.selectedGroupUuid}
            selectedEntryUuid={state.selectedEntryUuid}
            onReload={reloadTree}
        />
    );
}

function Ready({
    root,
    selectedGroupUuid,
    selectedEntryUuid,
    onReload
}: {
    root: GroupNode;
    selectedGroupUuid: string;
    selectedEntryUuid: string | undefined;
    onReload: (keepSelection?: { groupUuid: string; entryUuid?: string }) => Promise<void>;
}) {
    const selectedGroup = findGroup(root, selectedGroupUuid) ?? root;

    function selectGroup(groupUuid: string): void {
        void onReload({ groupUuid });
    }

    function selectEntry(entryUuid: string): void {
        void onReload({ groupUuid: selectedGroupUuid, entryUuid });
    }

    async function createGroup(parentGroupUuid: string): Promise<void> {
        const name = window.prompt('New group name');
        if (!name) {
            return;
        }
        const response = await sendToBackground({ type: 'CREATE_GROUP', parentGroupUuid, name });
        if (response.ok && response.type === 'CREATE_GROUP') {
            await onReload({ groupUuid: response.group.uuid });
        }
    }

    async function renameGroup(groupUuid: string, currentName: string): Promise<void> {
        const name = window.prompt('Rename group', currentName);
        if (!name || name === currentName) {
            return;
        }
        await sendToBackground({ type: 'RENAME_GROUP', groupUuid, name });
        await onReload({ groupUuid: selectedGroupUuid, entryUuid: selectedEntryUuid });
    }

    async function deleteGroup(groupUuid: string): Promise<void> {
        if (!window.confirm('Delete this group and everything in it?')) {
            return;
        }
        await sendToBackground({ type: 'DELETE_GROUP', groupUuid });
        await onReload({ groupUuid: root.uuid });
    }

    async function createEntry(): Promise<void> {
        const response = await sendToBackground({
            type: 'CREATE_ENTRY',
            groupUuid: selectedGroupUuid,
            fields: { title: 'New entry' }
        });
        if (response.ok && response.type === 'CREATE_ENTRY') {
            await onReload({ groupUuid: selectedGroupUuid, entryUuid: response.entry.uuid });
        }
    }

    return (
        <div className="layout">
            <div className="tree-pane">
                <div className="tree-pane-header">
                    <strong>Groups</strong>
                </div>
                <GroupTreeNode
                    node={root}
                    depth={0}
                    selectedGroupUuid={selectedGroupUuid}
                    onSelect={selectGroup}
                    onCreateChild={createGroup}
                    onRename={renameGroup}
                    onDelete={deleteGroup}
                    isRoot
                />
            </div>
            <div className="middle-pane">
                <div className="middle-pane-header">
                    <strong>{selectedGroup.name || 'Entries'}</strong>
                    <button type="button" onClick={() => void createEntry()}>
                        + Entry
                    </button>
                </div>
                {selectedGroup.entries.length === 0 && <p className="empty-state">No entries in this group.</p>}
                {selectedGroup.entries.map((entry) => (
                    <div
                        key={entry.uuid}
                        className={`entry-row${entry.uuid === selectedEntryUuid ? ' selected' : ''}`}
                        onClick={() => selectEntry(entry.uuid)}
                    >
                        <div className="entry-row-title">{entry.title || '(no title)'}</div>
                        <div className="entry-row-username">{entry.username}</div>
                    </div>
                ))}
            </div>
            <div className="detail-pane">
                {selectedEntryUuid ? (
                    <EntryDetailPanel
                        key={selectedEntryUuid}
                        entryUuid={selectedEntryUuid}
                        root={root}
                        onChanged={() => onReload({ groupUuid: selectedGroupUuid, entryUuid: selectedEntryUuid })}
                        onDeleted={() => onReload({ groupUuid: selectedGroupUuid })}
                    />
                ) : (
                    <p className="empty-state">Select an entry to view or edit it.</p>
                )}
            </div>
        </div>
    );
}

function GroupTreeNode({
    node,
    depth,
    selectedGroupUuid,
    onSelect,
    onCreateChild,
    onRename,
    onDelete,
    isRoot
}: {
    node: GroupNode;
    depth: number;
    selectedGroupUuid: string;
    onSelect: (uuid: string) => void;
    onCreateChild: (parentUuid: string) => Promise<void>;
    onRename: (uuid: string, currentName: string) => Promise<void>;
    onDelete: (uuid: string) => Promise<void>;
    isRoot?: boolean;
}) {
    return (
        <div className="tree-node">
            <div
                className={`tree-node-label${node.uuid === selectedGroupUuid ? ' selected' : ''}`}
                onClick={() => onSelect(node.uuid)}
            >
                <span className="tree-node-name">{node.name || '(unnamed)'}</span>
                <span className="tree-node-actions">
                    <button
                        type="button"
                        className="icon-button"
                        title="New subgroup"
                        onClick={(e) => {
                            e.stopPropagation();
                            void onCreateChild(node.uuid);
                        }}
                    >
                        +
                    </button>
                    {!isRoot && (
                        <>
                            <button
                                type="button"
                                className="icon-button"
                                title="Rename"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    void onRename(node.uuid, node.name);
                                }}
                            >
                                ✎
                            </button>
                            <button
                                type="button"
                                className="icon-button danger"
                                title="Delete"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    void onDelete(node.uuid);
                                }}
                            >
                                ×
                            </button>
                        </>
                    )}
                </span>
            </div>
            {node.groups.length > 0 && (
                <div className="tree-children">
                    {node.groups.map((child) => (
                        <GroupTreeNode
                            key={child.uuid}
                            node={child}
                            depth={depth + 1}
                            selectedGroupUuid={selectedGroupUuid}
                            onSelect={onSelect}
                            onCreateChild={onCreateChild}
                            onRename={onRename}
                            onDelete={onDelete}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function flattenGroups(node: GroupNode): GroupNode[] {
    return [node, ...node.groups.flatMap(flattenGroups)];
}

function findGroup(node: GroupNode, uuid: string): GroupNode | undefined {
    return flattenGroups(node).find((g) => g.uuid === uuid);
}

function EntryDetailPanel({
    entryUuid,
    root,
    onChanged,
    onDeleted
}: {
    entryUuid: string;
    root: GroupNode;
    onChanged: () => void;
    onDeleted: () => void;
}) {
    const [entry, setEntry] = useState<EntryDetail | undefined>(undefined);
    const [showPassword, setShowPassword] = useState(false);
    const [savedFlash, setSavedFlash] = useState(false);

    useEffect(() => {
        void load();
    }, [entryUuid]);

    async function load(): Promise<void> {
        const response = await sendToBackground({ type: 'GET_ENTRY_DETAIL', entryUuid });
        if (response.ok && response.type === 'GET_ENTRY_DETAIL') {
            setEntry(response.entry);
        }
    }

    async function saveField(field: 'title' | 'username' | 'password' | 'url' | 'notes', value: string): Promise<void> {
        if (!entry || entry[field] === value) {
            return;
        }
        await sendToBackground({ type: 'UPDATE_ENTRY', entryUuid, fields: { [field]: value } });
        setEntry({ ...entry, [field]: value });
        flashSaved();
        onChanged();
    }

    function flashSaved(): void {
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1200);
    }

    async function deleteEntry(): Promise<void> {
        if (!window.confirm('Delete this entry?')) {
            return;
        }
        await sendToBackground({ type: 'DELETE_ENTRY', entryUuid });
        onDeleted();
    }

    async function moveTo(toGroupUuid: string): Promise<void> {
        if (toGroupUuid === entry?.groupUuid) {
            return;
        }
        await sendToBackground({ type: 'MOVE_ENTRY', entryUuid, toGroupUuid });
        onChanged();
    }

    async function addAttachment(file: File): Promise<void> {
        const buffer = await file.arrayBuffer();
        const dataBase64 = ByteUtils.bytesToBase64(new Uint8Array(buffer));
        await sendToBackground({ type: 'ADD_ATTACHMENT', entryUuid, name: file.name, dataBase64 });
        await load();
        flashSaved();
    }

    async function removeAttachment(name: string): Promise<void> {
        await sendToBackground({ type: 'REMOVE_ATTACHMENT', entryUuid, name });
        await load();
    }

    async function downloadAttachment(name: string): Promise<void> {
        const response = await sendToBackground({ type: 'GET_ATTACHMENT', entryUuid, name });
        if (!response.ok || response.type !== 'GET_ATTACHMENT') {
            return;
        }
        const bytes = ByteUtils.base64ToBytes(response.dataBase64);
        const blob = new Blob([bytes]);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
    }

    if (!entry) {
        return <p>Loading…</p>;
    }

    return (
        <div>
            <div className="field">
                <label>Title</label>
                <input
                    type="text"
                    defaultValue={entry.title}
                    onBlur={(e) => void saveField('title', e.target.value)}
                />
            </div>
            <div className="field">
                <label>Username</label>
                <input
                    type="text"
                    defaultValue={entry.username}
                    onBlur={(e) => void saveField('username', e.target.value)}
                />
            </div>
            <div className="field">
                <label>Password</label>
                <div className="password-row">
                    <input
                        type={showPassword ? 'text' : 'password'}
                        defaultValue={entry.password}
                        onBlur={(e) => void saveField('password', e.target.value)}
                    />
                    <button type="button" onClick={() => setShowPassword((v) => !v)}>
                        {showPassword ? 'Hide' : 'Show'}
                    </button>
                </div>
            </div>
            <div className="field">
                <label>URL</label>
                <input type="text" defaultValue={entry.url} onBlur={(e) => void saveField('url', e.target.value)} />
            </div>
            <div className="field">
                <label>Notes</label>
                <textarea defaultValue={entry.notes} onBlur={(e) => void saveField('notes', e.target.value)} />
            </div>
            <div className="field">
                <label>Group</label>
                <select value={entry.groupUuid} onChange={(e) => void moveTo(e.target.value)}>
                    {flattenGroups(root).map((g) => (
                        <option key={g.uuid} value={g.uuid}>
                            {g.name || '(unnamed)'}
                        </option>
                    ))}
                </select>
            </div>

            <div className="attachments">
                <label>Attachments</label>
                {entry.attachments.map((a) => (
                    <div className="attachment-row" key={a.name}>
                        <span>
                            {a.name} ({a.size} bytes)
                        </span>
                        <span>
                            <button type="button" onClick={() => void downloadAttachment(a.name)}>
                                Download
                            </button>
                            <button type="button" className="danger" onClick={() => void removeAttachment(a.name)}>
                                Remove
                            </button>
                        </span>
                    </div>
                ))}
                <input
                    type="file"
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                            void addAttachment(file);
                        }
                        e.target.value = '';
                    }}
                />
            </div>

            <p style={{ marginTop: '1rem' }}>
                {savedFlash && <span className="save-indicator">Saved</span>}
            </p>
            <button type="button" className="danger" onClick={() => void deleteEntry()}>
                Delete entry
            </button>
        </div>
    );
}
