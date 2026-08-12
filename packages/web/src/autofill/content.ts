import { detectLoginForm, detectOneTimeCodeField } from './detector';
import { fillField } from './filler';
import type { ContentScriptMessage } from './messages';
import { sendToBackground, type PageEntryMatch } from '../background/message-bus';

// Detect form, signal background, receive fill message (§5.1); never holds credentials.

let pageEntryMatches: PageEntryMatch[] = [];
let menuHost: HTMLDivElement | undefined;
let entryMarkerHost: HTMLDivElement | undefined;
let entryMarkerField: HTMLInputElement | undefined;
let entryMarkerResizeObserver: ResizeObserver | undefined;
const capturedLoginForms = new WeakSet<HTMLFormElement>();

function tryDetectAndNotify(): boolean {
    const form = detectLoginForm(document);
    if (!form) {
        return false;
    }
    void sendToBackground({ type: 'LOGIN_FORM_DETECTED' });
    captureSubmittedLogin(form);
    void loadPageEntryMatches(form);
    return true;
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
        if (!username && !password) {
            return;
        }
        void sendToBackground({
            type: 'CAPTURE_LOGIN_CREDENTIALS',
            title: document.title,
            url: window.location.href,
            username: username || undefined,
            password: password || undefined
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
    button.innerHTML = `<style>
        :host { all: initial; }
        button { display: grid; width: 24px; height: 24px; place-items: center; border: 0; border-radius: 50%; background: transparent; cursor: pointer; padding: 0; }
        button:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
        img { width: 100%; height: 100%; border-radius: 50%; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35)); }
    </style><img src="${chrome.runtime.getURL('icons/keetar-32.png')}" alt="">`;
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
    entryMarkerHost.style.cssText = `position:fixed;z-index:2147483646;display:block;left:${Math.max(0, rect.right - 28)}px;top:${Math.max(0, rect.top + (rect.height - 24) / 2)}px;`;
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
    menu.innerHTML = `<style>
        :host { all: initial; }
        .menu { position: fixed; z-index: 2147483647; width: min(18rem, calc(100vw - 1rem)); padding: 0.35rem; border: 1px solid #9ca3af; border-radius: 6px; background: #fff; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2); font-family: system-ui, sans-serif; color: #111827; }
        .heading { display: block; padding: 0.25rem 0.4rem 0.4rem; color: #4b5563; font-size: 0.75rem; font-weight: 600; }
        button { display: block; width: 100%; overflow: hidden; border: 0; border-radius: 4px; background: transparent; padding: 0.45rem 0.4rem; color: inherit; cursor: pointer; font: inherit; font-size: 0.875rem; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
        button:hover, button:focus { background: #e5e7eb; outline: none; }
    </style>`;
    menu.className = 'menu';
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 296))}px`;
    menu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 120)}px`;
    const heading = document.createElement('span');
    heading.className = 'heading';
    heading.textContent = 'Keetar entries';
    menu.append(heading);
    for (const entry of pageEntryMatches) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = entry.title || '(no title)';
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
    await sendToBackground({ type: 'FILL_PAGE_ENTRY', entryUuid });
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
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden', 'aria-hidden']
    });
}

chrome.runtime.onMessage.addListener((message: ContentScriptMessage) => {
    if (message?.type === 'REDETECT_LOGIN_FORM') {
        tryDetectAndNotify();
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
