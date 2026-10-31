// Firefox closes popups on the credential prompt (bug 2026687), so the popup hands unlock to an Options tab.
const UNLOCK_PARAM = 'biometric-unlock';

export async function openBiometricUnlockTab(): Promise<void> {
    const url = `${chrome.runtime.getURL('options/options.html')}?${UNLOCK_PARAM}=1`;
    await chrome.tabs.create({ url });
}

// Clears the flag so a page reload can't start a second ceremony.
export function consumeBiometricUnlockRequest(): boolean {
    const url = new URL(window.location.href);
    const requested = url.searchParams.has(UNLOCK_PARAM);
    if (requested) {
        url.searchParams.delete(UNLOCK_PARAM);
        window.history.replaceState(null, '', url);
    }
    return requested;
}

export function closeCurrentTab(): void {
    chrome.tabs.getCurrent((tab) => {
        if (tab?.id !== undefined) {
            void chrome.tabs.remove(tab.id);
        }
    });
}
