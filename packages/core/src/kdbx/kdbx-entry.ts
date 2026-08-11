import * as XmlNames from './../defs/xml-names.js';
import * as XmlUtils from './../utils/xml-utils.js';
import { KdbxTimes } from './kdbx-times.js';
import { AutoTypeObfuscationOptions, Icons } from '../defs/consts.js';
import { ProtectedValue } from '../crypto/protected-value.js';
import { KdbxCustomData, KdbxCustomDataMap } from './kdbx-custom-data.js';
import { KdbxUuid } from './kdbx-uuid.js';
import { KdbxContext } from './kdbx-context.js';
import { KdbxBinaries, KdbxBinary, KdbxBinaryOrRef, KdbxBinaryWithHash } from './kdbx-binaries.js';
import { KdbxMeta } from './kdbx-meta.js';
import { KdbxGroup } from './kdbx-group.js';
import { MergeObjectMap } from './kdbx.js';

export type KdbxEntryField = string | ProtectedValue;

export interface KdbxAutoTypeItem {
    window: string;
    keystrokeSequence: string;
}

export interface KdbxEntryAutoType {
    enabled: boolean;
    obfuscation: number;
    defaultSequence?: string;
    items: KdbxAutoTypeItem[];
}

export interface KdbxEntryEditState {
    added: number[];
    deleted: number[];
}

export class KdbxEntry {
    uuid = new KdbxUuid();
    icon: number | undefined;
    customIcon: KdbxUuid | undefined;
    fgColor: string | undefined;
    bgColor: string | undefined;
    overrideUrl: string | undefined;
    tags: string[] = [];
    times = new KdbxTimes();
    fields = new Map<string, KdbxEntryField>();
    binaries = new Map<string, KdbxBinary | KdbxBinaryWithHash>();
    autoType: KdbxEntryAutoType = {
        enabled: true,
        obfuscation: AutoTypeObfuscationOptions.None,
        items: []
    };
    history: KdbxEntry[] = [];
    parentGroup: KdbxGroup | undefined;
    previousParentGroup: KdbxUuid | undefined;
    customData: KdbxCustomDataMap | undefined;
    qualityCheck: boolean | undefined;
    _editState: KdbxEntryEditState | undefined;

    get lastModTime(): number {
        return this.times.lastModTime?.getTime() ?? 0;
    }

    get locationChanged(): number {
        return this.times.locationChanged?.getTime() ?? 0;
    }

    private readNode(node: Element, ctx: KdbxContext) {
        switch (node.tagName) {
            case XmlNames.Elem.Uuid:
                this.uuid = XmlUtils.getUuid(node) ?? new KdbxUuid();
                break;
            case XmlNames.Elem.Icon:
                this.icon = XmlUtils.getNumber(node) || Icons.Key;
                break;
            case XmlNames.Elem.CustomIconID:
                this.customIcon = XmlUtils.getUuid(node);
                break;
            case XmlNames.Elem.FgColor:
                this.fgColor = XmlUtils.getText(node);
                break;
            case XmlNames.Elem.BgColor:
                this.bgColor = XmlUtils.getText(node);
                break;
            case XmlNames.Elem.OverrideUrl:
                this.overrideUrl = XmlUtils.getText(node);
                break;
            case XmlNames.Elem.Tags:
                this.tags = XmlUtils.getTags(node);
                break;
            case XmlNames.Elem.Times:
                this.times = KdbxTimes.read(node);
                break;
            case XmlNames.Elem.String:
                this.readField(node);
                break;
            case XmlNames.Elem.Binary:
                this.readBinary(node, ctx);
                break;
            case XmlNames.Elem.AutoType:
                this.readAutoType(node);
                break;
            case XmlNames.Elem.History:
                this.readHistory(node, ctx);
                break;
            case XmlNames.Elem.CustomData:
                this.readCustomData(node);
                break;
            case XmlNames.Elem.QualityCheck:
                this.qualityCheck = XmlUtils.getBoolean(node) ?? undefined;
                break;
            case XmlNames.Elem.PreviousParentGroup:
                this.previousParentGroup = XmlUtils.getUuid(node);
                break;
        }
    }

    private readField(node: Element) {
        const keyNode = XmlUtils.getChildNode(node, XmlNames.Elem.Key),
            valueNode = XmlUtils.getChildNode(node, XmlNames.Elem.Value);
        if (keyNode && valueNode) {
            const key = XmlUtils.getText(keyNode),
                value = XmlUtils.getProtectedText(valueNode);
            if (key) {
                this.fields.set(key, value || '');
            }
        }
    }

    private writeFields(parentNode: Node) {
        for (const [field, value] of this.fields) {
            if (value !== undefined && value !== null) {
                const node = XmlUtils.addChildNode(parentNode, XmlNames.Elem.String);
                XmlUtils.setText(XmlUtils.addChildNode(node, XmlNames.Elem.Key), field);
                XmlUtils.setProtectedText(XmlUtils.addChildNode(node, XmlNames.Elem.Value), value);
            }
        }
    }

    private readBinary(node: Element, ctx: KdbxContext) {
        const keyNode = XmlUtils.getChildNode(node, XmlNames.Elem.Key),
            valueNode = XmlUtils.getChildNode(node, XmlNames.Elem.Value);
        if (keyNode && valueNode) {
            const key = XmlUtils.getText(keyNode),
                value = XmlUtils.getProtectedBinary(valueNode);
            if (key && value) {
                if (KdbxBinaries.isKdbxBinaryRef(value)) {
                    const binary = ctx.kdbx.binaries.getByRef(value);
                    if (binary) {
                        this.binaries.set(key, binary);
                    }
                } else {
                    this.binaries.set(key, value);
                }
            }
        }
    }

    private writeBinaries(parentNode: Node, ctx: KdbxContext) {
        for (const [id, data] of this.binaries) {
            let bin: KdbxBinaryOrRef;
            if (KdbxBinaries.isKdbxBinaryWithHash(data)) {
                const binaryRef = ctx.kdbx.binaries.getRefByHash(data.hash);
                if (!binaryRef) {
                    return;
                }
                bin = binaryRef;
            } else {
                bin = data;
            }
            const node = XmlUtils.addChildNode(parentNode, XmlNames.Elem.Binary);
            XmlUtils.setText(XmlUtils.addChildNode(node, XmlNames.Elem.Key), id);
            XmlUtils.setProtectedBinary(XmlUtils.addChildNode(node, XmlNames.Elem.Value), bin);
        }
    }

    private readAutoType(node: Node) {
        for (let i = 0, cn = node.childNodes, len = cn.length; i < len; i++) {
            const childNode = <Element>cn[i];
            switch (childNode.tagName) {
                case XmlNames.Elem.AutoTypeEnabled:
                    this.autoType.enabled = XmlUtils.getBoolean(childNode) ?? true;
                    break;
                case XmlNames.Elem.AutoTypeObfuscation:
                    this.autoType.obfuscation =
                        XmlUtils.getNumber(childNode) || AutoTypeObfuscationOptions.None;
                    break;
                case XmlNames.Elem.AutoTypeDefaultSeq:
                    this.autoType.defaultSequence = XmlUtils.getText(childNode);
                    break;
                case XmlNames.Elem.AutoTypeItem:
                    this.readAutoTypeItem(childNode);
                    break;
            }
        }
    }

    private readAutoTypeItem(node: Node) {
        let window = '';
        let keystrokeSequence = '';
        for (let i = 0, cn = node.childNodes, len = cn.length; i < len; i++) {
            const childNode = <Element>cn[i];
            switch (childNode.tagName) {
                case XmlNames.Elem.Window:
                    window = XmlUtils.getText(childNode) || '';
                    break;
                case XmlNames.Elem.KeystrokeSequence:
                    keystrokeSequence = XmlUtils.getText(childNode) || '';
                    break;
            }
        }
        if (window && keystrokeSequence) {
            this.autoType.items.push({ window, keystrokeSequence });
        }
    }

    private writeAutoType(parentNode: Node) {
        const node = XmlUtils.addChildNode(parentNode, XmlNames.Elem.AutoType);
        XmlUtils.setBoolean(
            XmlUtils.addChildNode(node, XmlNames.Elem.AutoTypeEnabled),
            this.autoType.enabled
        );
        XmlUtils.setNumber(
            XmlUtils.addChildNode(node, XmlNames.Elem.AutoTypeObfuscation),
            this.autoType.obfuscation || AutoTypeObfuscationOptions.None
        );
        if (this.autoType.defaultSequence) {
            XmlUtils.setText(
                XmlUtils.addChildNode(node, XmlNames.Elem.AutoTypeDefaultSeq),
                this.autoType.defaultSequence
            );
        }
        for (let i = 0; i < this.autoType.items.length; i++) {
            const item = this.autoType.items[i];
            const itemNode = XmlUtils.addChildNode(node, XmlNames.Elem.AutoTypeItem);
            XmlUtils.setText(XmlUtils.addChildNode(itemNode, XmlNames.Elem.Window), item.window);
            XmlUtils.setText(
                XmlUtils.addChildNode(itemNode, XmlNames.Elem.KeystrokeSequence),
                item.keystrokeSequence
            );
        }
    }

    private readHistory(node: Node, ctx: KdbxContext) {
        for (let i = 0, cn = node.childNodes, len = cn.length; i < len; i++) {
            const childNode = <Element>cn[i];
            switch (childNode.tagName) {
                case XmlNames.Elem.Entry:
                    this.history.push(KdbxEntry.read(childNode, ctx));
                    break;
            }
        }
    }

    private writeHistory(parentNode: Node, ctx: KdbxContext) {
        const historyNode = XmlUtils.addChildNode(parentNode, XmlNames.Elem.History);
        for (const historyEntry of this.history) {
            historyEntry.write(historyNode, ctx);
        }
    }

    private readCustomData(node: Node) {
        this.customData = KdbxCustomData.read(node);
    }

    private writeCustomData(parentNode: Node, ctx: KdbxContext) {
        if (this.customData) {
            KdbxCustomData.write(parentNode, ctx, this.customData);
        }
    }

    private setField(name: string, str: string, secure = false) {
        this.fields.set(name, secure ? ProtectedValue.fromString(str) : str);
    }

    private addHistoryTombstone(isAdded: boolean, dt: Date) {
        if (!this._editState) {
            this._editState = { added: [], deleted: [] };
        }
        this._editState[isAdded ? 'added' : 'deleted'].push(dt.getTime());
    }

    write(parentNode: Element, ctx: KdbxContext): void {
        const node = XmlUtils.addChildNode(parentNode, XmlNames.Elem.Entry);
        XmlUtils.setUuid(XmlUtils.addChildNode(node, XmlNames.Elem.Uuid), this.uuid);
        XmlUtils.setNumber(XmlUtils.addChildNode(node, XmlNames.Elem.Icon), this.icon || Icons.Key);
        if (this.customIcon) {
            XmlUtils.setUuid(
                XmlUtils.addChildNode(node, XmlNames.Elem.CustomIconID),
                this.customIcon
            );
        }
        XmlUtils.setText(XmlUtils.addChildNode(node, XmlNames.Elem.FgColor), this.fgColor);
        XmlUtils.setText(XmlUtils.addChildNode(node, XmlNames.Elem.BgColor), this.bgColor);
        XmlUtils.setText(XmlUtils.addChildNode(node, XmlNames.Elem.OverrideUrl), this.overrideUrl);
        XmlUtils.setTags(XmlUtils.addChildNode(node, XmlNames.Elem.Tags), this.tags);
        if (typeof this.qualityCheck === 'boolean' && ctx.kdbx.versionIsAtLeast(4, 1)) {
            XmlUtils.setBoolean(
                XmlUtils.addChildNode(node, XmlNames.Elem.QualityCheck),
                this.qualityCheck
            );
        }
        if (this.previousParentGroup !== undefined && ctx.kdbx.versionIsAtLeast(4, 1)) {
            XmlUtils.setUuid(
                XmlUtils.addChildNode(node, XmlNames.Elem.PreviousParentGroup),
                this.previousParentGroup
            );
        }
        this.times.write(node, ctx);
        this.writeFields(node);
        this.writeBinaries(node, ctx);
        this.writeAutoType(node);
        this.writeCustomData(node, ctx);
        if (parentNode.tagName !== XmlNames.Elem.History) {
            this.writeHistory(node, ctx);
        }
    }

    pushHistory(): void {
        const historyEntry = new KdbxEntry();
        historyEntry.copyFrom(this);
        this.history.push(historyEntry);
        if (historyEntry.times.lastModTime) {
            this.addHistoryTombstone(true, historyEntry.times.lastModTime);
        }
    }

    removeHistory(index: number, count = 1): void {
        for (let ix = index; ix < index + count; ix++) {
            if (ix < this.history.length) {
                const lastModTime = this.history[ix].times.lastModTime;
                if (lastModTime) {
                    this.addHistoryTombstone(false, lastModTime);
                }
            }
        }
        this.history.splice(index, count);
    }

    copyFrom(entry: KdbxEntry): void {
        this.uuid = entry.uuid;
        this.icon = entry.icon;
        this.customIcon = entry.customIcon;
        this.fgColor = entry.fgColor;
        this.bgColor = entry.bgColor;
        this.overrideUrl = entry.overrideUrl;
        this.tags = entry.tags.slice();
        this.times = entry.times.clone();

        this.fields = new Map<string, KdbxEntryField>();
        for (const [name, value] of entry.fields) {
            if (value instanceof ProtectedValue) {
                this.fields.set(name, value.clone());
            } else {
                this.fields.set(name, value);
            }
        }

        this.binaries = new Map<string, KdbxBinary | KdbxBinaryWithHash>();
        for (const [name, value] of entry.binaries) {
            if (value instanceof ProtectedValue) {
                this.binaries.set(name, value.clone());
            } else if (KdbxBinaries.isKdbxBinaryWithHash(value)) {
                this.binaries.set(name, { hash: value.hash, value: value.value });
            } else {
                this.binaries.set(name, value);
            }
        }

        this.autoType = <KdbxEntryAutoType>JSON.parse(JSON.stringify(entry.autoType));
    }

    merge(objectMap: MergeObjectMap): void {
        const remoteEntry = objectMap.remoteEntries.get(this.uuid.id);
        if (!remoteEntry) {
            return;
        }
        const remoteHistory = remoteEntry.history.slice();
        if (this.lastModTime < remoteEntry.lastModTime) {
            // Remote is newer
            this.pushHistory();
            this.copyFrom(remoteEntry);
        } else if (this.lastModTime > remoteEntry.lastModTime) {
            // Local is newer; add remote to history if not present
            const existsInHistory = this.history.some((historyEntry) => {
                return historyEntry.lastModTime === remoteEntry.lastModTime;
            });
            if (!existsInHistory) {
                const historyEntry = new KdbxEntry();
                historyEntry.copyFrom(remoteEntry);
                remoteHistory.push(historyEntry);
            }
        }
        this.history = this.mergeHistory(remoteHistory, remoteEntry.lastModTime);
    }

    /** Merge histories using remove-win OR-set CRDT with local tombstones (arXiv:1210.3368) */
    private mergeHistory(remoteHistory: KdbxEntry[], remoteLastModTime: number) {
        // we can skip sorting but the history may not have been sorted
        this.history.sort((x, y) => x.lastModTime - y.lastModTime);
        remoteHistory.sort((x, y) => x.lastModTime - y.lastModTime);
        let historyIx = 0,
            remoteHistoryIx = 0;
        const newHistory = [];
        while (historyIx < this.history.length || remoteHistoryIx < remoteHistory.length) {
            const historyEntry = this.history[historyIx],
                remoteHistoryEntry = remoteHistory[remoteHistoryIx],
                entryTime = historyEntry && historyEntry.lastModTime,
                remoteEntryTime = remoteHistoryEntry && remoteHistoryEntry.lastModTime;
            if (entryTime === remoteEntryTime) {
                // exists in local and remote
                newHistory.push(historyEntry);
                historyIx++;
                remoteHistoryIx++;
                continue;
            }
            if (!historyEntry || entryTime > remoteEntryTime) {
                // local is absent
                if (!this._editState || this._editState.deleted.indexOf(remoteEntryTime) < 0) {
                    // added remotely
                    const remoteHistoryEntryClone = new KdbxEntry();
                    remoteHistoryEntryClone.copyFrom(remoteHistoryEntry);
                    newHistory.push(remoteHistoryEntryClone);
                } // else: deleted locally
                remoteHistoryIx++;
                continue;
            }
            // (!remoteHistoryEntry || entryTime < remoteEntryTime) && historyEntry
            // remote is absent
            if (this._editState && this._editState.added.indexOf(entryTime) >= 0) {
                // added locally
                newHistory.push(historyEntry);
            } else if (entryTime > remoteLastModTime) {
                // outdated replica history has ended
                newHistory.push(historyEntry);
            } // else: deleted remotely
            historyIx++;
        }
        return newHistory;
    }

    static create(meta: KdbxMeta, parentGroup: KdbxGroup): KdbxEntry {
        const entry = new KdbxEntry();
        entry.uuid = KdbxUuid.random();
        entry.icon = Icons.Key;
        entry.times = KdbxTimes.create();
        entry.parentGroup = parentGroup;
        entry.setField('Title', '', meta.memoryProtection.title);
        entry.setField('UserName', meta.defaultUser || '', meta.memoryProtection.userName);
        entry.setField('Password', '', meta.memoryProtection.password);
        entry.setField('URL', '', meta.memoryProtection.url);
        entry.setField('Notes', '', meta.memoryProtection.notes);
        entry.autoType.enabled =
            typeof parentGroup.enableAutoType === 'boolean' ? parentGroup.enableAutoType : true;
        entry.autoType.obfuscation = AutoTypeObfuscationOptions.None;
        return entry;
    }

    static read(xmlNode: Node, ctx: KdbxContext, parentGroup?: KdbxGroup): KdbxEntry {
        const entry = new KdbxEntry();
        for (let i = 0, cn = xmlNode.childNodes, len = cn.length; i < len; i++) {
            const childNode = <Element>cn[i];
            if (childNode.tagName) {
                entry.readNode(childNode, ctx);
            }
        }
        if (entry.uuid.empty) {
            // some clients don't write ids
            entry.uuid = KdbxUuid.random();
            for (let j = 0; j < entry.history.length; j++) {
                entry.history[j].uuid = entry.uuid;
            }
        }
        entry.parentGroup = parentGroup;
        return entry;
    }
}
