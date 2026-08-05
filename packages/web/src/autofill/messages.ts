// Popup → content script, direct via chrome.tabs.sendMessage (not routed
// through background's message-bus.ts — a different channel, scoped to
// exactly the tab the user is looking at).
export interface FillCredentialsMessage {
    type: 'FILL_CREDENTIALS';
    username?: string;
    password?: string;
    otp?: string;
}
