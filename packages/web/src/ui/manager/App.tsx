import { useEffect, useState } from 'react';
import { ByteUtils, estimatePasswordEntropy } from '@keetar/core';
import { sendToBackground } from '../../background/message-bus';
import { EntryIcon } from '../shared/EntryIcon';
import type {
    CombineConflict,
    CombineResolution,
    EntryDetail,
    GroupNode,
    PasswordHealthReport
} from '../../background/vault-session';

// Full vault management post-unlock: entries, groups, attachments (§8.1–8.2); shares background session with Popup.

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
    const [healthReport, setHealthReport] = useState<PasswordHealthReport | undefined>(undefined);
    const [healthError, setHealthError] = useState<string | undefined>(undefined);
    const [checkingHealth, setCheckingHealth] = useState(false);
    const [showImportExport, setShowImportExport] = useState(false);
    const [showCombine, setShowCombine] = useState(false);
    const [fetchingFavicons, setFetchingFavicons] = useState(false);
    const [faviconStatus, setFaviconStatus] = useState<string | undefined>(undefined);

    function selectGroup(groupUuid: string): void {
        void onReload({ groupUuid });
    }

    function selectEntry(entryUuid: string): void {
        setHealthReport(undefined);
        setHealthError(undefined);
        setShowImportExport(false);
        setShowCombine(false);
        void onReload({ groupUuid: selectedGroupUuid, entryUuid });
    }

    function toggleImportExport(): void {
        setHealthReport(undefined);
        setHealthError(undefined);
        setShowCombine(false);
        setShowImportExport((shown) => !shown);
    }

    function toggleCombine(): void {
        setHealthReport(undefined);
        setHealthError(undefined);
        setShowImportExport(false);
        setShowCombine((shown) => !shown);
    }

    async function loadPasswordHealth(): Promise<void> {
        setCheckingHealth(true);
        setHealthError(undefined);
        try {
            const response = await sendToBackground({ type: 'GET_PASSWORD_HEALTH' });
            if (response.ok && response.type === 'GET_PASSWORD_HEALTH') {
                setHealthReport(response.report);
            } else if (!response.ok) {
                setHealthError(response.error);
            }
        } finally {
            setCheckingHealth(false);
        }
    }

    // Bulk fetch favicons for all entries with URL but no custom icon.
    async function fetchAllFavicons(): Promise<void> {
        setFetchingFavicons(true);
        setFaviconStatus(undefined);
        try {
            const response = await sendToBackground({ type: 'FETCH_MISSING_FAVICONS' });
            if (!response.ok || response.type !== 'FETCH_MISSING_FAVICONS') {
                setFaviconStatus(!response.ok ? `Failed: ${response.error}` : 'Failed to fetch favicons.');
                return;
            }
            const { updated, failed } = response;
            setFaviconStatus(
                `Fetched ${updated} favicon${updated === 1 ? '' : 's'}` +
                    (failed > 0 ? `, ${failed} not found or failed.` : '.')
            );
            if (updated > 0) {
                await onReload({ groupUuid: selectedGroupUuid, entryUuid: selectedEntryUuid });
            }
        } finally {
            setFetchingFavicons(false);
        }
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
                    <button type="button" onClick={() => void loadPasswordHealth()} disabled={checkingHealth}>
                        {checkingHealth ? 'Checking' : 'Health'}
                    </button>
                    <button type="button" onClick={toggleImportExport}>
                        Import/Export
                    </button>
                    <button type="button" onClick={toggleCombine}>
                        Combine Vaults
                    </button>
                    <button type="button" onClick={() => void fetchAllFavicons()} disabled={fetchingFavicons}>
                        {fetchingFavicons ? 'Fetching…' : 'Fetch Favicons'}
                    </button>
                </div>
                {faviconStatus && (
                    <p className="entry-row-username" style={{ padding: '0 0.5rem' }}>
                        {faviconStatus}
                    </p>
                )}
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
                        <EntryIcon entryUuid={entry.uuid} icon={entry.icon} hasCustomIcon={entry.hasCustomIcon} />
                        <div className="entry-row-text">
                            <div className="entry-row-title">{entry.title || '(no title)'}</div>
                            <div className="entry-row-username">{entry.username}</div>
                        </div>
                    </div>
                ))}
            </div>
            <div className="detail-pane">
                {showImportExport ? (
                    <ImportExportPanel
                        selectedGroupUuid={selectedGroupUuid}
                        selectedGroupName={selectedGroup.name || 'root'}
                        onImported={() => {
                            setShowImportExport(false);
                            void onReload({ groupUuid: selectedGroupUuid });
                        }}
                        onClose={() => setShowImportExport(false)}
                    />
                ) : showCombine ? (
                    <CombineVaultsPanel
                        selectedGroupUuid={selectedGroupUuid}
                        selectedGroupName={selectedGroup.name || 'root'}
                        onCombined={() => void onReload({ groupUuid: selectedGroupUuid })}
                        onClose={() => setShowCombine(false)}
                    />
                ) : healthReport ? (
                    <PasswordHealthPanel report={healthReport} onClose={() => setHealthReport(undefined)} />
                ) : healthError ? (
                    <div className="empty-state">
                        <p>{healthError}</p>
                        <button type="button" onClick={() => setHealthError(undefined)}>
                            Close
                        </button>
                    </div>
                ) : selectedEntryUuid ? (
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

function PasswordHealthPanel({ report, onClose }: { report: PasswordHealthReport; onClose: () => void }) {
    return (
        <div>
            <div className="middle-pane-header">
                <strong>Password health</strong>
                <button type="button" onClick={onClose}>
                    Close
                </button>
            </div>
            <p>
                {report.total} entries: {report.weak} weak, {report.reused} reused, {report.old} old, {report.breached}{' '}
                breached.
            </p>
            {report.findings.length === 0 ? (
                <p className="empty-state">No password issues found.</p>
            ) : (
                <ul className="health-list">
                    {report.findings.map((finding) => (
                        <li key={finding.entryUuid} className="health-row">
                            <div className="entry-row-title">{finding.title || '(no title)'}</div>
                            <div className="entry-row-username">
                                {[
                                    finding.weak && `weak (${finding.entropy.toFixed(1)} bits)`,
                                    finding.reused && 'reused',
                                    finding.old && 'old',
                                    finding.breachCount > 0 && `breached (${finding.breachCount})`
                                ]
                                    .filter(Boolean)
                                    .join(', ')}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

type ImportFormat = 'csv' | 'bitwarden' | 'onepassword' | 'protonpass';

const IMPORT_FORMAT_LABELS: Record<ImportFormat, string> = {
    csv: 'CSV (generic / KeePass export)',
    bitwarden: 'Bitwarden (JSON export)',
    onepassword: '1Password (.1pux export)',
    protonpass: 'Proton Pass (JSON export)'
};

function ImportExportPanel({
    selectedGroupUuid,
    selectedGroupName,
    onImported,
    onClose
}: {
    selectedGroupUuid: string;
    selectedGroupName: string;
    onImported: () => void;
    onClose: () => void;
}) {
    const [importFormat, setImportFormat] = useState<ImportFormat>('csv');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState<string | undefined>(undefined);

    async function handleImportFile(file: File): Promise<void> {
        setBusy(true);
        setStatus(undefined);
        try {
            const buffer = await file.arrayBuffer();
            const dataBase64 = ByteUtils.bytesToBase64(new Uint8Array(buffer));
            const response = await sendToBackground({
                type: 'IMPORT_ENTRIES',
                format: importFormat,
                dataBase64,
                groupUuid: selectedGroupUuid
            });
            if (response.ok && response.type === 'IMPORT_ENTRIES') {
                setStatus(`Imported ${response.imported} ${response.imported === 1 ? 'entry' : 'entries'}.`);
                onImported();
            } else if (!response.ok) {
                setStatus(`Import failed: ${response.error}`);
            }
        } finally {
            setBusy(false);
        }
    }

    async function handleExport(format: 'csv' | 'xml'): Promise<void> {
        setStatus(undefined);
        const response = await sendToBackground({ type: 'EXPORT_VAULT', format });
        if (!response.ok || response.type !== 'EXPORT_VAULT') {
            setStatus(`Export failed: ${!response.ok ? response.error : 'unknown error'}`);
            return;
        }
        const blob = new Blob([response.data], { type: format === 'csv' ? 'text/csv' : 'application/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `keetar-export.${format}`;
        a.click();
        URL.revokeObjectURL(url);
    }

    return (
        <div>
            <div className="middle-pane-header">
                <strong>Import / Export</strong>
                <button type="button" onClick={onClose}>
                    Close
                </button>
            </div>

            <h4>Import</h4>
            <p>New entries are added into "{selectedGroupName}" — select that group in the tree first if needed.</p>
            <div className="field">
                <label>Source format</label>
                <select value={importFormat} onChange={(e) => setImportFormat(e.target.value as ImportFormat)}>
                    {(Object.keys(IMPORT_FORMAT_LABELS) as ImportFormat[]).map((format) => (
                        <option key={format} value={format}>
                            {IMPORT_FORMAT_LABELS[format]}
                        </option>
                    ))}
                </select>
            </div>
            <input
                type="file"
                disabled={busy}
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                        void handleImportFile(file);
                    }
                    e.target.value = '';
                }}
            />

            <h4 style={{ marginTop: '1.5rem' }}>Export</h4>
            <p>Exports every entry outside the recycle bin, in plain text — store the file securely.</p>
            <button type="button" onClick={() => void handleExport('csv')}>
                Export as CSV
            </button>{' '}
            <button type="button" onClick={() => void handleExport('xml')}>
                Export as XML
            </button>

            {status && <p style={{ marginTop: '1rem' }}>{status}</p>}
        </div>
    );
}

type CombineStep =
    | { kind: 'pick' }
    | {
          kind: 'reviewing';
          conflicts: CombineConflict[];
          nonConflictingCount: number;
          identicalCount: number;
          resolutions: Record<string, CombineResolution>;
      }
    | { kind: 'done'; imported: number; merged: number; replaced: number };

function describeConflictSide(entries: CombineConflict['primary']): string {
    return entries.map((e) => `${e.title || '(no title)'} (${e.username})`).join(', ');
}

// Merge second .kdbx into current vault; conflicts resolved by username+domain heuristic (§9).
function CombineVaultsPanel({
    selectedGroupUuid,
    selectedGroupName,
    onCombined,
    onClose
}: {
    selectedGroupUuid: string;
    selectedGroupName: string;
    onCombined: () => void;
    onClose: () => void;
}) {
    const [step, setStep] = useState<CombineStep>({ kind: 'pick' });
    const [pendingFile, setPendingFile] = useState<File | undefined>(undefined);
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);

    // Close secondary vault if panel is dismissed (cleanup).
    useEffect(() => {
        return () => void sendToBackground({ type: 'CLOSE_SECONDARY_VAULT' });
    }, []);

    async function openSecondary(): Promise<void> {
        if (!pendingFile || !password) {
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            const buffer = await pendingFile.arrayBuffer();
            const dataBase64 = ByteUtils.bytesToBase64(new Uint8Array(buffer));
            const openResponse = await sendToBackground({ type: 'OPEN_SECONDARY_VAULT', dataBase64, password });
            if (!openResponse.ok || openResponse.type !== 'OPEN_SECONDARY_VAULT') {
                setError(!openResponse.ok ? openResponse.error : 'Could not open the second vault.');
                return;
            }
            const previewResponse = await sendToBackground({ type: 'PREVIEW_COMBINE' });
            if (!previewResponse.ok || previewResponse.type !== 'PREVIEW_COMBINE') {
                setError(!previewResponse.ok ? previewResponse.error : 'Could not compare vaults.');
                await sendToBackground({ type: 'CLOSE_SECONDARY_VAULT' });
                return;
            }
            const resolutions: Record<string, CombineResolution> = {};
            for (const conflict of previewResponse.conflicts) {
                resolutions[conflict.key] = 'keep-a';
            }
            setStep({
                kind: 'reviewing',
                conflicts: previewResponse.conflicts,
                nonConflictingCount: previewResponse.nonConflictingCount,
                identicalCount: previewResponse.identicalCount,
                resolutions
            });
        } finally {
            setBusy(false);
        }
    }

    function setResolution(key: string, resolution: CombineResolution): void {
        if (step.kind !== 'reviewing') {
            return;
        }
        setStep({ ...step, resolutions: { ...step.resolutions, [key]: resolution } });
    }

    async function apply(): Promise<void> {
        if (step.kind !== 'reviewing') {
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            const response = await sendToBackground({
                type: 'APPLY_COMBINE',
                groupUuid: selectedGroupUuid,
                resolutions: step.resolutions
            });
            if (!response.ok || response.type !== 'APPLY_COMBINE') {
                setError(!response.ok ? response.error : 'Combine failed.');
                return;
            }
            setStep({
                kind: 'done',
                imported: response.imported,
                merged: response.merged,
                replaced: response.replaced
            });
            onCombined();
        } finally {
            setBusy(false);
        }
    }

    return (
        <div>
            <div className="middle-pane-header">
                <strong>Combine Vaults</strong>
                <button type="button" onClick={onClose}>
                    Close
                </button>
            </div>

            {step.kind === 'pick' && (
                <>
                    <p>Open a second .kdbx file to fold its entries into "{selectedGroupName}".</p>
                    <div className="field">
                        <label>Second vault file</label>
                        <input type="file" accept=".kdbx" onChange={(e) => setPendingFile(e.target.files?.[0])} />
                    </div>
                    <div className="field">
                        <label>Its master password</label>
                        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                    </div>
                    <button type="button" disabled={!pendingFile || !password || busy} onClick={() => void openSecondary()}>
                        {busy ? 'Opening…' : 'Open & Compare'}
                    </button>
                </>
            )}

            {step.kind === 'reviewing' && (
                <>
                    <p>
                        {step.identicalCount > 0 &&
                            `${step.identicalCount} identical ${step.identicalCount === 1 ? 'entry' : 'entries'} (same username, site, and password) will be left as-is. `}
                        {step.conflicts.length === 0
                            ? 'No other overlapping entries found.'
                            : `${step.conflicts.length} ${step.conflicts.length === 1 ? 'entry needs' : 'entries need'} a decision — same username + site, but the password differs.`}{' '}
                        {step.nonConflictingCount} other {step.nonConflictingCount === 1 ? 'entry' : 'entries'} will import automatically.
                    </p>
                    {step.conflicts.map((conflict) => (
                        <div key={conflict.key} className="field">
                            <div>
                                <strong>Existing:</strong> {describeConflictSide(conflict.primary)}
                            </div>
                            <div>
                                <strong>Incoming:</strong> {describeConflictSide(conflict.secondary)}
                            </div>
                            <select
                                value={step.resolutions[conflict.key]}
                                onChange={(e) => setResolution(conflict.key, e.target.value as CombineResolution)}
                            >
                                <option value="keep-a">Keep existing</option>
                                <option value="keep-b">Keep incoming</option>
                                <option value="keep-both">Keep both</option>
                            </select>
                        </div>
                    ))}
                    <button type="button" disabled={busy} onClick={() => void apply()}>
                        {busy ? 'Combining…' : 'Combine'}
                    </button>
                </>
            )}

            {step.kind === 'done' && (
                <p>
                    Imported {step.imported} new {step.imported === 1 ? 'entry' : 'entries'}, merged{' '}
                    {step.merged} matched {step.merged === 1 ? 'entry' : 'entries'}
                    {step.replaced > 0
                        ? `, replaced ${step.replaced} existing ${step.replaced === 1 ? 'entry' : 'entries'}`
                        : ''}
                    .
                </p>
            )}

            {error && <p className="empty-state">{error}</p>}
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
    const [fetchingFavicon, setFetchingFavicon] = useState(false);
    const [faviconError, setFaviconError] = useState<string | undefined>(undefined);

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

    async function useFavicon(): Promise<void> {
        setFetchingFavicon(true);
        setFaviconError(undefined);
        try {
            const response = await sendToBackground({ type: 'FETCH_FAVICON_ICON', entryUuid });
            if (!response.ok) {
                setFaviconError(response.error);
                return;
            }
            await load();
            flashSaved();
        } finally {
            setFetchingFavicon(false);
        }
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
            <div className="entry-detail-header">
                <EntryIcon entryUuid={entry.uuid} icon={entry.icon} hasCustomIcon={entry.hasCustomIcon} size={28} />
                <button type="button" disabled={!entry.url || fetchingFavicon} onClick={() => void useFavicon()}>
                    {fetchingFavicon ? 'Fetching…' : 'Use site favicon'}
                </button>
                {faviconError && <span className="entry-row-username">{faviconError}</span>}
            </div>
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
                <PasswordEditor
                    initialPassword={entry.password}
                    showPassword={showPassword}
                    onToggleVisibility={() => setShowPassword((visible) => !visible)}
                    onSave={(password) => saveField('password', password)}
                />
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

function PasswordEditor({
    initialPassword,
    showPassword,
    onToggleVisibility,
    onSave
}: {
    initialPassword: string;
    showPassword: boolean;
    onToggleVisibility: () => void;
    onSave: (password: string) => Promise<void>;
}) {
    const [password, setPassword] = useState(initialPassword);
    const [entropy, setEntropy] = useState<number | undefined>(undefined);

    useEffect(() => {
        setEntropy(undefined);
        const timer = window.setTimeout(() => {
            void estimatePasswordEntropy(password).then(setEntropy, () => setEntropy(undefined));
        }, 150);
        return () => window.clearTimeout(timer);
    }, [password]);

    return (
        <>
            <div className="password-row">
                <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onBlur={() => void onSave(password)}
                />
                <button type="button" onClick={onToggleVisibility}>
                    {showPassword ? 'Hide' : 'Show'}
                </button>
            </div>
            <div className="password-strength">
                {entropy === undefined
                    ? 'Checking strength…'
                    : entropy < 75
                      ? `Weak (${entropy.toFixed(1)} bits)`
                      : `Strong (${entropy.toFixed(1)} bits)`}
            </div>
        </>
    );
}
