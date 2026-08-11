// Popup → content script via chrome.tabs.sendMessage (direct, not via message-bus).
export interface FillCredentialsMessage {
    type: 'FILL_CREDENTIALS';
    username?: string;
    password?: string;
    otp?: string;
}

export interface RedetectLoginFormMessage {
    type: 'REDETECT_LOGIN_FORM';
}

export type ContentScriptMessage = FillCredentialsMessage | RedetectLoginFormMessage;
