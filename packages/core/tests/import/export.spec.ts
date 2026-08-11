import { describe, expect, test } from 'vitest';
import { exportToXml } from '../../src/import/export.js';
import * as XmlUtils from '../../src/utils/xml-utils.js';

describe('XML export', () => {
    test('serializes entries into a flat <Entries><Entry> document', () => {
        const xml = exportToXml([
            {
                title: 'Example',
                username: 'alice',
                password: 'hunter2',
                url: 'https://example.com',
                notes: 'hi',
                group: 'Work',
                tags: ['a', 'b'],
                totpSecret: 'JBSWY3DPEHPK3PXP'
            }
        ]);

        const doc = XmlUtils.parse(xml);
        const entry = XmlUtils.getChildNode(doc.documentElement, 'Entry');
        expect(entry).toBeTruthy();
        expect(XmlUtils.getText(XmlUtils.getChildNode(entry, 'Title'))).toBe('Example');
        expect(XmlUtils.getText(XmlUtils.getChildNode(entry, 'Username'))).toBe('alice');
        expect(XmlUtils.getText(XmlUtils.getChildNode(entry, 'Password'))).toBe('hunter2');
        expect(XmlUtils.getText(XmlUtils.getChildNode(entry, 'URL'))).toBe('https://example.com');
        expect(XmlUtils.getText(XmlUtils.getChildNode(entry, 'Notes'))).toBe('hi');
        expect(XmlUtils.getText(XmlUtils.getChildNode(entry, 'Group'))).toBe('Work');
        expect(XmlUtils.getText(XmlUtils.getChildNode(entry, 'TOTP'))).toBe('JBSWY3DPEHPK3PXP');
        expect(XmlUtils.getTags(XmlUtils.getChildNode(entry, 'Tags')!)).toEqual(['a', 'b']);
    });

    test('escapes special characters safely via the XML DOM serializer', () => {
        const xml = exportToXml([
            { title: '<script>&"\'', username: '', password: '', url: '', notes: '' }
        ]);
        expect(xml).not.toContain('<script>');
        const doc = XmlUtils.parse(xml);
        const entry = XmlUtils.getChildNode(doc.documentElement, 'Entry');
        expect(XmlUtils.getText(XmlUtils.getChildNode(entry, 'Title'))).toBe('<script>&"\'');
    });

    test('omits Group/TOTP/Tags nodes when absent', () => {
        const xml = exportToXml([{ title: 'Example', username: '', password: '', url: '', notes: '' }]);
        const doc = XmlUtils.parse(xml);
        const entry = XmlUtils.getChildNode(doc.documentElement, 'Entry');
        expect(XmlUtils.getChildNode(entry, 'Group')).toBeNull();
        expect(XmlUtils.getChildNode(entry, 'TOTP')).toBeNull();
        expect(XmlUtils.getChildNode(entry, 'Tags')).toBeNull();
    });
});
