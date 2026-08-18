import { tabs, windows } from '../../platform';

// Manager owns editing; reuse its existing tab (and raise its window) rather than opening a new one every time.
export async function openManagerTab(entryUuid?: string): Promise<void> {
    const managerUrl = chrome.runtime.getURL('manager/manager.html');
    const url = entryUuid ? `${managerUrl}?${new URLSearchParams({ entry: entryUuid })}` : managerUrl;
    const openTabs = await tabs.query({});
    const existingManagerTab = openTabs.find((tab) => tab.url?.split(/[?#]/, 1)[0] === managerUrl);
    if (existingManagerTab?.id !== undefined) {
        await tabs.update(existingManagerTab.id, { active: true, url });
        if (existingManagerTab.windowId !== undefined) {
            await windows.update(existingManagerTab.windowId, { focused: true });
        }
        return;
    }
    await chrome.tabs.create({ url });
}
