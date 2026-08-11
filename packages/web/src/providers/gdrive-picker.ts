import { loadGooglePicker } from 'google-picker-offline-loader';
import { isChrome } from '../platform';
import { DRIVE_SCOPE, GOOGLE_CLIENT_ID, GOOGLE_PICKER_API_KEY, GOOGLE_PICKER_APP_ID, getAccessToken } from './gdrive';

// PickerBuilder.setAppId missing from types but exists at runtime—augment locally for proper typing downstream.
declare module 'google-picker-offline-loader' {
    interface PickerBuilder {
        setAppId(appId: string): PickerBuilder;
    }
}

// UNVERIFIED: setVisible needs real OAuth token + key to test end-to-end (still placeholders, see §7.3).
export async function showDrivePicker(): Promise<{ fileId: string; name: string } | undefined> {
    // Chrome reuses extension's token; Firefox bridge runs separate implicit-grant (see showDrivePickerViaBridge).
    return isChrome ? showDrivePickerDirect(await getAccessToken()) : showDrivePickerViaBridge();
}

async function showDrivePickerDirect(accessToken: string): Promise<{ fileId: string; name: string } | undefined> {
    const pickerApi = await loadGooglePicker({
        resolveAssetUrl: (file) => chrome.runtime.getURL(`vendor/google-picker/${file}`)
    });

    return new Promise((resolve) => {
        const view = new pickerApi.DocsView(pickerApi.ViewId.DOCS).setIncludeFolders(false).setSelectFolderEnabled(false);
        const picker = new pickerApi.PickerBuilder()
            .addView(view)
            .setOAuthToken(accessToken)
            .setDeveloperKey(GOOGLE_PICKER_API_KEY)
            .setAppId(GOOGLE_PICKER_APP_ID)
            .setCallback((data) => {
                if (data.action === pickerApi.Action.PICKED) {
                    const doc = data.docs?.[0];
                    resolve(doc ? { fileId: doc.id, name: doc.name } : undefined);
                } else if (data.action === pickerApi.Action.CANCEL) {
                    resolve(undefined);
                }
            })
            .build();
        picker.setVisible(true);
    });
}

// Firefox: Picker rejects moz-extension:// (confirmed 2026-08-06)—route through Cloudflare bridge. Popup not iframe (ancestorOrigins check).
// URL params in hash (postMessage broken on Firefox). Bridge runs own implicit-grant for session cookie scoping.
const BRIDGE_URL = 'https://google-picker-bridge.papacodebear.workers.dev/';
const CALLBACK_PATH = 'picker-callback/picker-callback.html';

interface PickerCallbackMessage {
    type: string;
    fileId?: string;
    name?: string;
    error?: string;
}

async function showDrivePickerViaBridge(): Promise<{ fileId: string; name: string } | undefined> {
    return new Promise((resolve, reject) => {
        const payload = {
            developerKey: GOOGLE_PICKER_API_KEY,
            appId: GOOGLE_PICKER_APP_ID,
            clientId: GOOGLE_CLIENT_ID,
            scope: DRIVE_SCOPE,
            callbackUrl: chrome.runtime.getURL(CALLBACK_PATH)
        };
        const popupUrl = `${BRIDGE_URL}#${encodeURIComponent(JSON.stringify(payload))}`;
        const popup = window.open(popupUrl, 'keetar-google-picker', 'width=1050,height=650');
        if (!popup) {
            reject(new Error('Could not open the Google Picker window — check that popups are allowed for this extension.'));
            return;
        }

        // No close-popup detection (polling popup.closed touches stale reference)—known gap: promise never settles if manually closed.
        function onRuntimeMessage(message: unknown): void {
            const data = message as PickerCallbackMessage;
            if (!data || data.type !== 'KEETAR_PICKER_CALLBACK') {
                return;
            }
            chrome.runtime.onMessage.removeListener(onRuntimeMessage);
            if (data.error) {
                reject(new Error(data.error));
                return;
            }
            resolve(data.fileId ? { fileId: data.fileId, name: data.name ?? '' } : undefined);
        }
        chrome.runtime.onMessage.addListener(onRuntimeMessage);
    });
}
