import { useEffect, useMemo, useState } from 'react';
import { ByteUtils, estimatePasswordEntropy } from '@keetar/core';
import { sendToBackground } from '../../background/message-bus';
import { EntryIcon } from '../shared/EntryIcon';
import { buildAiSortExport, diffAiSortAssignments, parseAiSortResponse } from './ai-sort';
import { getSortedEntryUuids, markEntriesSorted } from './ai-sort-tracker';
import { connectGoogleDrive, getAccessToken, GoogleDriveProvider } from '../../providers/gdrive';
import { showDrivePicker } from '../../providers/gdrive-picker';
import { clearConfiguredVault, getConfiguredVault } from '../../config/vault-config';
import type { AiSortDiff } from './ai-sort';
import type {
    CombineConflict,
    CombineResolution,
    EntryDetail,
    EntrySummary,
    GroupNode,
    PasswordHealthReport
} from '../../background/vault-session';

// Full vault management post-unlock: entries, groups, attachments (§8.1–8.2); shares background session with Popup.

// Verify Google Drive token is live before offering picker (not just cached).
async function ensureGoogleDriveAuthorized(): Promise<void> {
    try {
        await getAccessToken();
    } catch {
        await connectGoogleDrive();
    }
}

type AppState =
    | { kind: 'loading' }
    | { kind: 'locked' }
    | { kind: 'disconnected' }
    | {
          kind: 'ready';
          root: GroupNode;
          recycleBinGroupUuid: string | undefined;
          vaultUuid: string | undefined;
          selectedGroupUuid: string;
          selectedEntryUuid?: string;
      };

export function App() {
    const [state, setState] = useState<AppState>({ kind: 'loading' });

    useEffect(() => {
        void init();
    }, []);

    // Distinguishes "locked, unlock from the popup" from "nothing configured at all" (e.g. after Disconnect).
    async function notReadyState(): Promise<AppState> {
        const configured = await getConfiguredVault();
        return configured ? { kind: 'locked' } : { kind: 'disconnected' };
    }

    async function init(): Promise<void> {
        const status = await sendToBackground({ type: 'GET_STATUS' });
        if (!status.ok || status.type !== 'GET_STATUS' || status.status !== 'unlocked') {
            setState(await notReadyState());
            return;
        }
        await reloadTree();
    }

    async function reloadTree(keepSelection?: { groupUuid: string; entryUuid?: string }): Promise<void> {
        const response = await sendToBackground({ type: 'GET_GROUP_TREE' });
        if (!response.ok || response.type !== 'GET_GROUP_TREE') {
            setState(await notReadyState());
            return;
        }
        const configured = await getConfiguredVault();
        setState({
            kind: 'ready',
            root: response.root,
            recycleBinGroupUuid: response.recycleBinGroupUuid,
            vaultUuid: configured?.uuid,
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
    if (state.kind === 'disconnected') {
        return (
            <div className="empty-state">
                <p>No database connected.</p>
                <p>Open or create one from the extension's popup or options page.</p>
            </div>
        );
    }

    return (
        <Ready
            root={state.root}
            recycleBinGroupUuid={state.recycleBinGroupUuid}
            vaultUuid={state.vaultUuid}
            selectedGroupUuid={state.selectedGroupUuid}
            selectedEntryUuid={state.selectedEntryUuid}
            onReload={reloadTree}
        />
    );
}

function Ready({
    root,
    recycleBinGroupUuid,
    vaultUuid,
    selectedGroupUuid,
    selectedEntryUuid,
    onReload
}: {
    root: GroupNode;
    recycleBinGroupUuid: string | undefined;
    vaultUuid: string | undefined;
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
    const [showAiSort, setShowAiSort] = useState(false);
    const [fetchingFavicons, setFetchingFavicons] = useState(false);
    const [faviconStatus, setFaviconStatus] = useState<string | undefined>(undefined);
    const [search, setSearch] = useState('');
    const [searchResults, setSearchResults] = useState<EntrySummary[] | undefined>(undefined);

    // Password matching runs in the background, not here — passwords never enter this state (§8.2).
    useEffect(() => {
        const term = search.trim();
        if (!term) {
            setSearchResults(undefined);
            return;
        }
        const handle = setTimeout(() => {
            void sendToBackground({ type: 'SEARCH_ENTRIES', query: term }).then((response) => {
                if (response.ok && response.type === 'SEARCH_ENTRIES') {
                    setSearchResults(response.entries);
                }
            });
        }, 150);
        return () => clearTimeout(handle);
    }, [search]);

    const displayedEntries = sortByName(searchResults ?? selectedGroup.entries, (entry) => entry.title);

    function selectGroup(groupUuid: string): void {
        void onReload({ groupUuid });
    }

    function selectEntry(entryUuid: string): void {
        setHealthReport(undefined);
        setHealthError(undefined);
        setShowImportExport(false);
        setShowCombine(false);
        setShowAiSort(false);
        void onReload({ groupUuid: selectedGroupUuid, entryUuid });
    }

    function toggleImportExport(): void {
        setHealthReport(undefined);
        setHealthError(undefined);
        setShowCombine(false);
        setShowAiSort(false);
        setShowImportExport((shown) => !shown);
    }

    function toggleAiSort(): void {
        setHealthReport(undefined);
        setHealthError(undefined);
        setShowImportExport(false);
        setShowCombine(false);
        setShowAiSort((shown) => !shown);
    }

    function toggleCombine(): void {
        setHealthReport(undefined);
        setHealthError(undefined);
        setShowImportExport(false);
        setShowAiSort(false);
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

    async function lockVault(): Promise<void> {
        await sendToBackground({ type: 'LOCK_VAULT' });
        await onReload();
    }

    async function disconnectVault(): Promise<void> {
        await sendToBackground({ type: 'LOCK_VAULT' });
        await clearConfiguredVault();
        await onReload();
    }

    async function emptyRecycleBin(): Promise<void> {
        if (!window.confirm('Permanently delete everything in the Recycle Bin? This cannot be undone.')) {
            return;
        }
        const response = await sendToBackground({ type: 'EMPTY_RECYCLE_BIN' });
        if (response.ok && response.type === 'EMPTY_RECYCLE_BIN') {
            await onReload({ groupUuid: selectedGroupUuid });
        }
    }

    return (
        <div className="layout">
            <div className="tree-pane">
                <input
                    type="text"
                    className="entry-search"
                    placeholder="Search all entries"
                    title="Searches title, username, URL, and password"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
                <div className="tree-pane-toolbar">
                    <button
                        type="button"
                        className="icon-button"
                        title={checkingHealth ? 'Checking password health…' : 'Password health'}
                        aria-label="Password health"
                        onClick={() => void loadPasswordHealth()}
                        disabled={checkingHealth}
                    >
                        {checkingHealth ? '⏳' : '🩺'}
                    </button>
                    <button
                        type="button"
                        className="icon-button"
                        title="Import / Export"
                        aria-label="Import / Export"
                        onClick={toggleImportExport}
                    >
                        ⇅
                    </button>
                    <button
                        type="button"
                        className="icon-button"
                        title="Combine Vaults"
                        aria-label="Combine Vaults"
                        onClick={toggleCombine}
                    >
                        🔀
                    </button>
                    <button
                        type="button"
                        className="icon-button"
                        title="Organize with AI"
                        aria-label="Organize with AI"
                        onClick={toggleAiSort}
                    >
                        ✨
                    </button>
                    <button
                        type="button"
                        className="icon-button"
                        title={fetchingFavicons ? 'Fetching favicons…' : 'Fetch Favicons'}
                        aria-label="Fetch Favicons"
                        onClick={() => void fetchAllFavicons()}
                        disabled={fetchingFavicons}
                    >
                        {fetchingFavicons ? '⏳' : '🌐'}
                    </button>
                    <button
                        type="button"
                        className="icon-button"
                        title="Lock database"
                        aria-label="Lock database"
                        onClick={() => void lockVault()}
                    >
                        🔒
                    </button>
                    <button
                        type="button"
                        className="icon-button danger"
                        title="Disconnect this database"
                        aria-label="Disconnect this database"
                        onClick={() => void disconnectVault()}
                    >
                        ✕
                    </button>
                </div>
                <div className="tree-pane-header">
                    <strong>Groups</strong>
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
                    recycleBinGroupUuid={recycleBinGroupUuid}
                    onSelect={selectGroup}
                    onCreateChild={createGroup}
                    onRename={renameGroup}
                    onDelete={deleteGroup}
                    isRoot
                />
            </div>
            <div className="middle-pane">
                <div className="middle-pane-header">
                    <strong>{search.trim() ? `Search results (${displayedEntries.length})` : selectedGroup.name || 'Entries'}</strong>
                    {!search.trim() && selectedGroupUuid === recycleBinGroupUuid ? (
                        <button
                            type="button"
                            onClick={() => void emptyRecycleBin()}
                            disabled={selectedGroup.entries.length === 0 && selectedGroup.groups.length === 0}
                        >
                            Empty Recycle Bin
                        </button>
                    ) : (
                        <button type="button" onClick={() => void createEntry()}>
                            + Entry
                        </button>
                    )}
                </div>
                {displayedEntries.length === 0 && (
                    <p className="empty-state">{search.trim() ? 'No matching entries.' : 'No entries in this group.'}</p>
                )}
                {displayedEntries.map((entry) => (
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
                ) : showAiSort ? (
                    <AiSortPanel
                        root={root}
                        recycleBinGroupUuid={recycleBinGroupUuid}
                        vaultUuid={vaultUuid}
                        onApplied={() => void onReload({ groupUuid: selectedGroupUuid })}
                        onClose={() => setShowAiSort(false)}
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

function titleFor(report: PasswordHealthReport, entryUuid: string): string {
    return report.findings.find((f) => f.entryUuid === entryUuid)?.title || '(no title)';
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
                breached, {report.similar} similar to another entry.
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
                                    finding.breachCount > 0 && `breached (${finding.breachCount})`,
                                    finding.similarEntryUuids.length > 0 &&
                                        `similar to ${finding.similarEntryUuids
                                            .map((uuid) => titleFor(report, uuid))
                                            .join(', ')}`
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

function AiSortPanel({
    root,
    recycleBinGroupUuid,
    vaultUuid,
    onApplied,
    onClose
}: {
    root: GroupNode;
    recycleBinGroupUuid: string | undefined;
    vaultUuid: string | undefined;
    onApplied: () => void;
    onClose: () => void;
}) {
    const [alreadySorted, setAlreadySorted] = useState<Set<string>>(new Set());
    const [includeAlreadySorted, setIncludeAlreadySorted] = useState(false);
    const [pasted, setPasted] = useState('');
    const [diff, setDiff] = useState<AiSortDiff | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [status, setStatus] = useState<string | undefined>(undefined);
    const [copied, setCopied] = useState(false);
    const [applying, setApplying] = useState(false);

    useEffect(() => {
        if (!vaultUuid) {
            return;
        }
        void getSortedEntryUuids(vaultUuid).then(setAlreadySorted);
    }, [vaultUuid]);

    const exportInfo = useMemo(
        () =>
            buildAiSortExport(
                root,
                recycleBinGroupUuid,
                includeAlreadySorted ? new Set() : alreadySorted,
                includeAlreadySorted
            ),
        [root, recycleBinGroupUuid, includeAlreadySorted, alreadySorted]
    );

    async function copyExport(): Promise<void> {
        await navigator.clipboard.writeText(exportInfo.text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }

    function preview(): void {
        setError(undefined);
        setStatus(undefined);
        try {
            setDiff(diffAiSortAssignments(root, recycleBinGroupUuid, parseAiSortResponse(pasted)));
        } catch (e) {
            setDiff(undefined);
            setError(e instanceof Error ? e.message : String(e));
        }
    }

    async function apply(): Promise<void> {
        if (!diff) {
            return;
        }
        setApplying(true);
        setError(undefined);
        try {
            const assignments = diff.groups.flatMap((g) =>
                g.entries.map((e) => ({ entryUuid: e.entryUuid, groupName: g.groupName }))
            );
            const response = await sendToBackground({ type: 'APPLY_AI_SORT', assignments });
            if (!response.ok || response.type !== 'APPLY_AI_SORT') {
                setError(!response.ok ? response.error : 'Applying changes failed.');
                return;
            }
            if (vaultUuid) {
                await markEntriesSorted(vaultUuid, diff.consideredEntryUuids);
                setAlreadySorted(await getSortedEntryUuids(vaultUuid));
            }
            setStatus(
                `Created ${response.groupsCreated} ${response.groupsCreated === 1 ? 'group' : 'groups'}, moved ` +
                    `${response.entriesMoved} ${response.entriesMoved === 1 ? 'entry' : 'entries'}.`
            );
            setDiff(undefined);
            setPasted('');
            onApplied();
        } finally {
            setApplying(false);
        }
    }

    const totalChanges = diff?.groups.reduce((sum, g) => sum + g.entries.length, 0) ?? 0;

    return (
        <div>
            <div className="middle-pane-header">
                <strong>Organize with AI</strong>
                <button type="button" onClick={onClose}>
                    Close
                </button>
            </div>
            <p>
                Copy this list into your own Claude or ChatGPT conversation, ask it to group your entries, then
                paste its reply back below. Only titles, URLs, and current groups are included — never usernames or
                passwords.
            </p>
            <div className="field">
                <label>Export</label>
                <textarea readOnly rows={6} value={exportInfo.text} onFocus={(e) => e.target.select()} />
                <button type="button" onClick={() => void copyExport()} disabled={exportInfo.includedCount === 0}>
                    {copied ? 'Copied!' : 'Copy to clipboard'}
                </button>
                {exportInfo.skippedCount > 0 && (
                    <label>
                        <input
                            type="checkbox"
                            checked={includeAlreadySorted}
                            onChange={(e) => setIncludeAlreadySorted(e.target.checked)}
                        />{' '}
                        Re-sort already sorted entries ({exportInfo.skippedCount} hidden)
                    </label>
                )}
            </div>
            <div className="field">
                <label>Paste the AI's reply</label>
                <textarea
                    rows={6}
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                    placeholder='[{"id": "...", "group": "..."}]'
                />
                <button type="button" onClick={preview} disabled={!pasted.trim()}>
                    Preview changes
                </button>
            </div>
            {error && <p className="empty-state">{error}</p>}
            {status && <p style={{ marginTop: '1rem' }}>{status}</p>}
            {diff &&
                (totalChanges === 0 ? (
                    <p className="empty-state">
                        No changes to apply
                        {diff.unknownCount > 0 &&
                            ` — ${diff.unknownCount} unrecognized ${diff.unknownCount === 1 ? 'id' : 'ids'}`}
                        {diff.unchangedCount > 0 && ` — ${diff.unchangedCount} already in that group`}.
                    </p>
                ) : (
                    <div>
                        {(diff.unknownCount > 0 || diff.unchangedCount > 0) && (
                            <p className="entry-row-username">
                                {diff.unknownCount > 0 &&
                                    `${diff.unknownCount} unrecognized ${diff.unknownCount === 1 ? 'id' : 'ids'} skipped. `}
                                {diff.unchangedCount > 0 &&
                                    `${diff.unchangedCount} already in the right group.`}
                            </p>
                        )}
                        <ul className="health-list">
                            {diff.groups.map((g) => (
                                <li key={g.groupName} className="health-row">
                                    <div className="entry-row-title">
                                        {g.groupName}
                                        {g.isNew && ' (new)'}
                                    </div>
                                    <div className="entry-row-username">
                                        {g.entries.map((e) => e.title || '(no title)').join(', ')}
                                    </div>
                                </li>
                            ))}
                        </ul>
                        <button type="button" onClick={() => void apply()} disabled={applying}>
                            {applying ? 'Applying…' : `Apply (${totalChanges} ${totalChanges === 1 ? 'entry' : 'entries'})`}
                        </button>
                    </div>
                ))}
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
    const [source, setSource] = useState<'local' | 'gdrive'>('local');
    const [pendingFile, setPendingFile] = useState<File | undefined>(undefined);
    const [drivePick, setDrivePick] = useState<{ fileId: string; name: string } | undefined>(undefined);
    const [drivePickBusy, setDrivePickBusy] = useState(false);
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | undefined>(undefined);

    // Close secondary vault if panel is dismissed (cleanup).
    useEffect(() => {
        return () => void sendToBackground({ type: 'CLOSE_SECONDARY_VAULT' });
    }, []);

    async function pickFromDrive(): Promise<void> {
        setError(undefined);
        setDrivePickBusy(true);
        try {
            await ensureGoogleDriveAuthorized();
            const picked = await showDrivePicker();
            if (picked) {
                setDrivePick(picked);
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setDrivePickBusy(false);
        }
    }

    async function openSecondary(): Promise<void> {
        if (source === 'local' ? !pendingFile : !drivePick) {
            return;
        }
        if (!password) {
            return;
        }
        setBusy(true);
        setError(undefined);
        try {
            const buffer =
                source === 'local'
                    ? await pendingFile!.arrayBuffer()
                    : await new GoogleDriveProvider().read(drivePick!.fileId);
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
                    <p>Open a second vault to fold its entries into "{selectedGroupName}".</p>
                    <div className="field">
                        <label>
                            <input type="radio" checked={source === 'local'} onChange={() => setSource('local')} />{' '}
                            This computer
                        </label>{' '}
                        <label>
                            <input type="radio" checked={source === 'gdrive'} onChange={() => setSource('gdrive')} />{' '}
                            Google Drive
                        </label>
                    </div>
                    {source === 'local' ? (
                        <div className="field">
                            <label>Second vault file</label>
                            <input type="file" accept=".kdbx" onChange={(e) => setPendingFile(e.target.files?.[0])} />
                        </div>
                    ) : (
                        <div className="field">
                            <label>Second vault file</label>
                            <button type="button" onClick={() => void pickFromDrive()} disabled={drivePickBusy}>
                                {drivePickBusy
                                    ? 'Opening picker…'
                                    : drivePick
                                      ? `Change ("${drivePick.name}" selected)`
                                      : 'Choose from Google Drive'}
                            </button>
                        </div>
                    )}
                    <div className="field">
                        <label>Its master password</label>
                        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
                    </div>
                    <button
                        type="button"
                        disabled={(source === 'local' ? !pendingFile : !drivePick) || !password || busy}
                        onClick={() => void openSecondary()}
                    >
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
    recycleBinGroupUuid,
    onSelect,
    onCreateChild,
    onRename,
    onDelete,
    isRoot
}: {
    node: GroupNode;
    depth: number;
    selectedGroupUuid: string;
    recycleBinGroupUuid: string | undefined;
    onSelect: (uuid: string) => void;
    onCreateChild: (parentUuid: string) => Promise<void>;
    onRename: (uuid: string, currentName: string) => Promise<void>;
    onDelete: (uuid: string) => Promise<void>;
    isRoot?: boolean;
}) {
    // Recycle Bin always sorts to the bottom, set off by a separator, instead of wherever its name lands alphabetically.
    const regularGroups = node.groups.filter((group) => group.uuid !== recycleBinGroupUuid);
    const recycleBin = node.groups.find((group) => group.uuid === recycleBinGroupUuid);
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
                    {sortByName(regularGroups, (group) => group.name).map((child) => (
                        <GroupTreeNode
                            key={child.uuid}
                            node={child}
                            depth={depth + 1}
                            selectedGroupUuid={selectedGroupUuid}
                            recycleBinGroupUuid={recycleBinGroupUuid}
                            onSelect={onSelect}
                            onCreateChild={onCreateChild}
                            onRename={onRename}
                            onDelete={onDelete}
                        />
                    ))}
                    {recycleBin && (
                        <>
                            <hr className="tree-separator" />
                            <GroupTreeNode
                                key={recycleBin.uuid}
                                node={recycleBin}
                                depth={depth + 1}
                                selectedGroupUuid={selectedGroupUuid}
                                recycleBinGroupUuid={recycleBinGroupUuid}
                                onSelect={onSelect}
                                onCreateChild={onCreateChild}
                                onRename={onRename}
                                onDelete={onDelete}
                            />
                        </>
                    )}
                </div>
            )}
        </div>
    );
}

// KDBX has no sort-order field — this is a display-only, case-insensitive sort.
function sortByName<T>(items: T[], name: (item: T) => string): T[] {
    return [...items].sort((a, b) => name(a).localeCompare(name(b), undefined, { sensitivity: 'base' }));
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
                    {sortByName(flattenGroups(root), (g) => g.name).map((g) => (
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
