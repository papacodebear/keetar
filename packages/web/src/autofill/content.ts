import { detectLoginForm, detectOneTimeCodeField } from './detector';
import { fillField } from './filler';
import type { ContentScriptMessage } from './messages';
import { sendToBackground, type PageEntryMatch } from '../background/message-bus';
import { initPasskeyContentRelay } from '../passkey-provider/content-relay';
import { isHostTrusted, trustHost } from '../config/trusted-hosts';

// Detect form, signal background, receive fill message (§5.1); never holds credentials.

let pageEntryMatches: PageEntryMatch[] = [];
let menuHost: HTMLDivElement | undefined;
let entryMarkerHost: HTMLDivElement | undefined;
let entryMarkerField: HTMLInputElement | undefined;
let entryMarkerResizeObserver: ResizeObserver | undefined;
const capturedLoginForms = new WeakSet<HTMLFormElement>();

// Tracks last-notified fields so a client-side step change (username -> password) triggers a fresh detection.
let lastUsernameField: HTMLInputElement | undefined;
let lastPasswordField: HTMLInputElement | undefined;

function tryDetectAndNotify(force = false): void {
    const form = detectLoginForm(document);
    if (!form) {
        return;
    }
    if (!force && form.usernameField === lastUsernameField && form.passwordField === lastPasswordField) {
        return;
    }
    lastUsernameField = form.usernameField;
    lastPasswordField = form.passwordField;
    void sendToBackground({ type: 'LOGIN_FORM_DETECTED' });
    captureSubmittedLogin(form);
    void loadPageEntryMatches(form);
}

function captureSubmittedLogin(form: ReturnType<typeof detectLoginForm>): void {
    const loginForm = form?.usernameField?.form ?? form?.passwordField?.form;
    if (!loginForm || capturedLoginForms.has(loginForm)) {
        return;
    }
    capturedLoginForms.add(loginForm);
    loginForm.addEventListener('submit', () => {
        const username = form?.usernameField?.value.trim();
        const password = form?.passwordField?.value;
        // Every password field's value, not just the guessed one — lets the background
        // spot a Keetar-generated password even on a multi-password change-password form.
        const passwordCandidates = Array.from(loginForm.querySelectorAll('input[type="password"]'))
            .map((el) => (el as HTMLInputElement).value)
            .filter(Boolean);
        if (!username && !password && passwordCandidates.length === 0) {
            return;
        }
        void sendToBackground({
            type: 'CAPTURE_LOGIN_CREDENTIALS',
            title: document.title,
            url: window.location.href,
            username: username || undefined,
            password: password || undefined,
            passwordCandidates: passwordCandidates.length > 0 ? passwordCandidates : undefined
        });
    });
}

async function loadPageEntryMatches(form: ReturnType<typeof detectLoginForm>): Promise<void> {
    const response = await sendToBackground({ type: 'GET_PAGE_ENTRY_MATCHES' });
    if (!response.ok || response.type !== 'GET_PAGE_ENTRY_MATCHES') {
        return;
    }
    pageEntryMatches = response.matches;
    if (pageEntryMatches.length === 0) {
        return;
    }
    for (const field of [form?.usernameField, form?.passwordField]) {
        field?.addEventListener('click', () => showEntryMenu(field));
    }
    const loginForm = form?.usernameField?.form ?? form?.passwordField?.form;
    loginForm?.addEventListener('submit', () => {
        hideEntryMenu();
        removeEntryMarker();
    }, { once: true });
    showEntryMarker(form?.usernameField ?? form?.passwordField);
}

// Sites with a strict style-src CSP (no 'unsafe-inline') silently drop <style> tags and
// .cssText, even inside a shadow root — individual CSSOM property assignment isn't blocked.
function applyStyle(el: HTMLElement, styles: Partial<CSSStyleDeclaration>): void {
    Object.assign(el.style, styles);
}

function showEntryMarker(field: HTMLInputElement | undefined): void {
    removeEntryMarker();
    if (!field) {
        return;
    }
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    const button = document.createElement('button');
    button.type = 'button';
    button.title = 'Open Keetar entries';
    button.setAttribute('aria-label', 'Open Keetar entries');
    applyStyle(button, {
        display: 'grid',
        width: '24px',
        height: '24px',
        alignItems: 'center',
        justifyContent: 'center',
        border: '0',
        borderRadius: '50%',
        background: 'transparent',
        cursor: 'pointer',
        padding: '0'
    });
    button.addEventListener('focus', () => applyStyle(button, { outline: '2px solid #2563eb', outlineOffset: '2px' }));
    button.addEventListener('blur', () => applyStyle(button, { outline: '', outlineOffset: '' }));
    const img = document.createElement('img');
    img.src = chrome.runtime.getURL('icons/keetar-32.png');
    img.alt = '';
    applyStyle(img, {
        width: '100%',
        height: '100%',
        borderRadius: '50%',
        filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35))'
    });
    button.append(img);
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        showEntryMenu(field);
    });
    shadow.append(button);
    document.documentElement.append(host);
    entryMarkerHost = host;
    entryMarkerField = field;
    entryMarkerResizeObserver = new ResizeObserver(positionEntryMarker);
    entryMarkerResizeObserver.observe(field);
    positionEntryMarker();
    window.addEventListener('resize', positionEntryMarker);
    window.addEventListener('scroll', positionEntryMarker, true);
}

function positionEntryMarker(): void {
    if (!entryMarkerHost || !entryMarkerField) {
        return;
    }
    const rect = entryMarkerField.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
        entryMarkerHost.style.display = 'none';
        return;
    }
    applyStyle(entryMarkerHost, {
        position: 'fixed',
        zIndex: '2147483646',
        display: 'block',
        left: `${Math.max(0, rect.right - 28)}px`,
        top: `${Math.max(0, rect.top + (rect.height - 24) / 2)}px`
    });
}

function removeEntryMarker(): void {
    entryMarkerHost?.remove();
    entryMarkerHost = undefined;
    entryMarkerField = undefined;
    entryMarkerResizeObserver?.disconnect();
    entryMarkerResizeObserver = undefined;
    window.removeEventListener('resize', positionEntryMarker);
    window.removeEventListener('scroll', positionEntryMarker, true);
}

function showEntryMenu(field: HTMLInputElement): void {
    if (pageEntryMatches.length === 0) {
        return;
    }
    hideEntryMenu();
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    const rect = field.getBoundingClientRect();
    const menu = document.createElement('div');
    applyStyle(menu, {
        position: 'fixed',
        zIndex: '2147483647',
        width: 'min(288px, calc(100vw - 16px))',
        padding: '6px',
        border: '1px solid #9ca3af',
        borderRadius: '6px',
        background: '#fff',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.2)',
        fontFamily: 'system-ui, sans-serif',
        color: '#111827',
        left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 296))}px`,
        top: `${Math.min(rect.bottom + 6, window.innerHeight - 120)}px`
    });
    const heading = document.createElement('span');
    heading.textContent = 'Keetar entries';
    applyStyle(heading, {
        display: 'block',
        padding: '4px 6px 6px',
        color: '#4b5563',
        fontSize: '12px',
        fontWeight: '600'
    });
    menu.append(heading);
    for (const entry of pageEntryMatches) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = entry.title || '(no title)';
        applyStyle(button, {
            display: 'block',
            width: '100%',
            overflow: 'hidden',
            border: '0',
            borderRadius: '4px',
            background: 'transparent',
            padding: '7px 6px',
            color: 'inherit',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: '14px',
            textAlign: 'left',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
        });
        button.addEventListener('mouseenter', () => applyStyle(button, { background: '#e5e7eb' }));
        button.addEventListener('mouseleave', () => applyStyle(button, { background: 'transparent' }));
        button.addEventListener('focus', () => applyStyle(button, { background: '#e5e7eb', outline: 'none' }));
        button.addEventListener('blur', () => applyStyle(button, { background: 'transparent' }));
        button.addEventListener('click', () => void fillPageEntry(entry.uuid));
        menu.append(button);
    }
    shadow.append(menu);
    document.documentElement.append(host);
    menuHost = host;
    document.addEventListener('pointerdown', hideWhenOutside, true);
}

function hideWhenOutside(event: PointerEvent): void {
    if (menuHost && !menuHost.contains(event.target as Node)) {
        hideEntryMenu();
    }
}

function hideEntryMenu(): void {
    menuHost?.remove();
    menuHost = undefined;
    document.removeEventListener('pointerdown', hideWhenOutside, true);
}

async function fillPageEntry(entryUuid: string): Promise<void> {
    hideEntryMenu();
    if (!(await isHostTrusted(window.location.origin))) {
        showTrustPrompt(() => void doFillPageEntry(entryUuid));
        return;
    }
    await doFillPageEntry(entryUuid);
}

async function doFillPageEntry(entryUuid: string): Promise<void> {
    await sendToBackground({ type: 'FILL_PAGE_ENTRY', entryUuid });
}

let trustPromptHost: HTMLDivElement | undefined;

function hideTrustPrompt(): void {
    trustPromptHost?.remove();
    trustPromptHost = undefined;
}

// First autofill on a new host asks for confirmation; trusting persists so later fills don't re-prompt.
function showTrustPrompt(onTrust: () => void): void {
    hideTrustPrompt();
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    const backdrop = document.createElement('div');
    applyStyle(backdrop, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483647',
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif'
    });
    const card = document.createElement('div');
    applyStyle(card, {
        width: 'min(320px, calc(100vw - 32px))',
        padding: '16px',
        borderRadius: '8px',
        background: '#fff',
        color: '#111827',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.35)'
    });
    const heading = document.createElement('p');
    heading.textContent = `Trust ${window.location.hostname} with your Keetar password?`;
    applyStyle(heading, { margin: '0 0 6px', fontWeight: '600', fontSize: '14px' });
    const detail = document.createElement('p');
    detail.textContent = "Keetar only fills credentials into sites you've trusted. This won't be asked again for this site.";
    applyStyle(detail, { margin: '0 0 14px', fontSize: '12px', color: '#4b5563' });
    const actions = document.createElement('div');
    applyStyle(actions, { display: 'flex', justifyContent: 'flex-end', gap: '8px' });
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.textContent = 'Cancel';
    applyStyle(cancelButton, { padding: '6px 12px', border: '1px solid #9ca3af', borderRadius: '4px', background: '#fff', cursor: 'pointer' });
    cancelButton.addEventListener('click', hideTrustPrompt);
    const trustButton = document.createElement('button');
    trustButton.type = 'button';
    trustButton.textContent = 'Trust & Fill';
    applyStyle(trustButton, { padding: '6px 12px', border: '0', borderRadius: '4px', background: '#2563eb', color: '#fff', cursor: 'pointer' });
    trustButton.addEventListener('click', () => {
        hideTrustPrompt();
        void trustHost(window.location.origin).then(onTrust);
    });
    actions.append(cancelButton, trustButton);
    card.append(heading, detail, actions);
    backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop) {
            hideTrustPrompt();
        }
    });
    backdrop.append(card);
    shadow.append(backdrop);
    document.documentElement.append(host);
    trustPromptHost = host;
}

initPasskeyContentRelay();

tryDetectAndNotify();
// Watches for the page's whole lifetime — SPA flows can swap fields without navigating; the dedup above keeps this a no-op otherwise.
// Also re-syncs the marker's position: late-loading content can shift the field without a resize/scroll event ever firing.
const loginFormObserver = new MutationObserver(() => {
    tryDetectAndNotify();
    positionEntryMarker();
});
loginFormObserver.observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'aria-hidden']
});

chrome.runtime.onMessage.addListener((message: ContentScriptMessage) => {
    if (message?.type === 'REDETECT_LOGIN_FORM') {
        tryDetectAndNotify(true);
        return;
    }
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
