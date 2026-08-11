import { detectLoginForm, detectOneTimeCodeField } from './detector';
import { fillField } from './filler';
import type { FillCredentialsMessage } from './messages';
import { sendToBackground } from '../background/message-bus';

// Detect form, signal background, receive fill message (§5.1); never holds credentials.

function tryDetectAndNotify(): boolean {
    const form = detectLoginForm(document);
    if (!form) {
        return false;
    }
    void sendToBackground({ type: 'LOGIN_FORM_DETECTED' });
    return true;
}

if (!tryDetectAndNotify()) {
    // SPAs: watch for form after load, stop at first match (§5.2).
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
    // Multi-step flow may have only username field; fill only existing fields (§5.2).
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
