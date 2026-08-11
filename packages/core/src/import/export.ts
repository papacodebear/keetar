import * as XmlUtils from '../utils/xml-utils.js';
import { VaultEntryRecord } from './types.js';

export { exportToCsv } from './csv.js';

// Plain flat XML export: human-readable counterpart to exportToCsv, not the encrypted KDBX XML.
export function exportToXml(entries: VaultEntryRecord[]): string {
    const doc = XmlUtils.create('Entries');
    const root = doc.documentElement;
    if (!root) {
        throw new Error('failed to create XML document');
    }
    for (const entry of entries) {
        const entryNode = XmlUtils.addChildNode(root, 'Entry');
        if (entry.group) {
            XmlUtils.setText(XmlUtils.addChildNode(entryNode, 'Group'), entry.group);
        }
        XmlUtils.setText(XmlUtils.addChildNode(entryNode, 'Title'), entry.title);
        XmlUtils.setText(XmlUtils.addChildNode(entryNode, 'Username'), entry.username);
        XmlUtils.setText(XmlUtils.addChildNode(entryNode, 'Password'), entry.password);
        XmlUtils.setText(XmlUtils.addChildNode(entryNode, 'URL'), entry.url);
        XmlUtils.setText(XmlUtils.addChildNode(entryNode, 'Notes'), entry.notes);
        if (entry.totpSecret) {
            XmlUtils.setText(XmlUtils.addChildNode(entryNode, 'TOTP'), entry.totpSecret);
        }
        if (entry.tags?.length) {
            XmlUtils.setTags(XmlUtils.addChildNode(entryNode, 'Tags'), entry.tags);
        }
    }
    return XmlUtils.serialize(doc, true);
}
