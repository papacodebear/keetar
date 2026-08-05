import { detectLoginForm, detectOneTimeCodeField } from './detector';
import { fillField } from './filler';
import type { FillCredentialsMessage } from './messages';
import { sendToBackground } from '../background/message-bus';

// Content script: detect login form presence, signal background, receive
// fill message, inject into DOM (§5.1). This is the whole of what it's
// allowed to do — it never asks for or holds credentials; it can only say
// "there is a login form at <url>" and, later, receive plaintext for the
// specific fields it already found. Background derives the tab's URL itself
// from the message sender, so content.ts doesn't need to (and doesn't have
// any special access to) send it explicitly.

function tryDetectAndNotify(): boolean {
    const form = detectLoginForm(document);
    if (!form) {
        return false;
    }
    void sendToBackground({ type: 'LOGIN_FORM_DETECTED' });
    return true;
}

if (!tryDetectAndNotify()) {
    // SPAs render their login form after initial load — watch for it, but
    // stop watching the moment one is found (§5.2).
    const observer = new MutationObserver(() => {
        if (tryDetectAndNotify()) {
            observer.disconnect();
        }
    });
    observer.observe(document.body ?? document.documentElement, {
        childList: true,
        subtree: true
    });
}

chrome.runtime.onMessage.addListener((message: FillCredentialsMessage) => {
    if (message?.type !== 'FILL_CREDENTIALS') {
        return;
    }
    const form = detectLoginForm(document);
    // Only fill fields that actually exist — a multi-step flow (§5.2) may
    // have only a username field at this point, and there's nothing to fill
    // a password into yet.
    if (form?.usernameField && message.username !== undefined) {
        fillField(form.usernameField, message.username);
    }
    if (form?.passwordField && message.password !== undefined) {
        fillField(form.passwordField, message.password);
    }
    const otpField = detectOneTimeCodeField(document);
    if (otpField && message.otp !== undefined) {
        fillField(otpField, message.otp);
    }
});
