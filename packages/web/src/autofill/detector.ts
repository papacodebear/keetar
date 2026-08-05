// DOM heuristics for username/password field pairs (§5.2). Check in priority
// order, stop at the first strategy that finds anything — a later, less
// reliable strategy should never override an earlier, more reliable one.

export interface DetectedLoginForm {
    usernameField?: HTMLInputElement;
    passwordField?: HTMLInputElement;
}

type Strategy = (root: ParentNode) => DetectedLoginForm | undefined;

const NAME_ID_PASSWORD_PATTERN = /pass|pwd|credential/i;
const NAME_ID_USERNAME_PATTERN = /user|login|email/i;
const LABEL_PASSWORD_PATTERN = /password/i;
const LABEL_USERNAME_PATTERN = /username|e-?mail/i;

/**
 * Detects a login form under `root`. Returns undefined if nothing was found.
 * A result with only `usernameField` set (no `passwordField`) is a valid,
 * intentional outcome — see the multi-step login flow note below.
 */
export function detectLoginForm(root: ParentNode = document): DetectedLoginForm | undefined {
    const strategies: Strategy[] = [
        byAutocomplete,
        byEmailAndPassword,
        byTextAndPasswordProximity,
        byNameOrId,
        byLabelText,
        byPlaceholder
    ];
    for (const strategy of strategies) {
        const result = strategy(root);
        if (result) {
            return result;
        }
    }
    return undefined;
}

// 1. autocomplete="username" / autocomplete="current-password" (most reliable)
function byAutocomplete(root: ParentNode): DetectedLoginForm | undefined {
    const usernameField = query(root, 'input[autocomplete="username"]');
    const passwordField = query(root, 'input[autocomplete="current-password"]');
    return present(usernameField, passwordField);
}

// 2. input[type="email"] paired with input[type="password"]
function byEmailAndPassword(root: ParentNode): DetectedLoginForm | undefined {
    const passwordField = query(root, 'input[type="password"]');
    if (!passwordField) {
        return undefined;
    }
    const usernameField = query(root, 'input[type="email"]');
    return usernameField ? { usernameField, passwordField } : undefined;
}

// 3. input[type="text"] + input[type="password"] pair (check proximity in DOM)
//
// Requires an actual password field, unlike the other strategies — a lone
// input[type="text"] is too weak a signal on its own (a search box would
// match) to justify jumping to it ahead of the more specific name/id, label,
// and placeholder strategies (4–6) that follow. Those, along with strategies
// 1–2 above, already return a username-only result when no password field is
// found (via `present()`), which is what actually satisfies the multi-step
// login flow note (§5.2): a password field can legitimately be absent while
// a username field is present, and content.ts pre-fills just the username
// and waits rather than failing to detect the page at all.
function byTextAndPasswordProximity(root: ParentNode): DetectedLoginForm | undefined {
    const passwordField = query(root, 'input[type="password"]');
    if (!passwordField) {
        return undefined;
    }
    const container = passwordField.closest('form') ?? root;
    const textInputs = queryAll(container, 'input[type="text"]');
    // Nearest preceding text input, in document order.
    let usernameField: HTMLInputElement | undefined;
    for (const input of textInputs) {
        if (input.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING) {
            usernameField = input;
        }
    }
    return { usernameField, passwordField };
}

// 4. name / id attributes matching: user, login, email, pass, pwd, credential
function byNameOrId(root: ParentNode): DetectedLoginForm | undefined {
    let usernameField: HTMLInputElement | undefined;
    let passwordField: HTMLInputElement | undefined;
    for (const input of queryAll(root, 'input')) {
        const haystack = `${input.name} ${input.id}`;
        if (!passwordField && NAME_ID_PASSWORD_PATTERN.test(haystack)) {
            passwordField = input;
        } else if (!usernameField && NAME_ID_USERNAME_PATTERN.test(haystack)) {
            usernameField = input;
        }
    }
    return present(usernameField, passwordField);
}

// 5. <label> text containing "username", "email", "password"
function byLabelText(root: ParentNode): DetectedLoginForm | undefined {
    let usernameField: HTMLInputElement | undefined;
    let passwordField: HTMLInputElement | undefined;
    for (const label of Array.from(root.querySelectorAll('label'))) {
        const text = label.textContent ?? '';
        if (!passwordField && LABEL_PASSWORD_PATTERN.test(text)) {
            passwordField = resolveLabelTarget(label);
        } else if (!usernameField && LABEL_USERNAME_PATTERN.test(text)) {
            usernameField = resolveLabelTarget(label);
        }
    }
    return present(usernameField, passwordField);
}

function resolveLabelTarget(label: HTMLLabelElement): HTMLInputElement | undefined {
    const forId = label.getAttribute('for');
    if (forId) {
        const target = label.ownerDocument.getElementById(forId);
        if (target instanceof HTMLInputElement) {
            return target;
        }
    }
    const nested = label.querySelector('input');
    return nested instanceof HTMLInputElement ? nested : undefined;
}

// 6. placeholder text containing the same keywords
function byPlaceholder(root: ParentNode): DetectedLoginForm | undefined {
    let usernameField: HTMLInputElement | undefined;
    let passwordField: HTMLInputElement | undefined;
    for (const input of queryAll(root, 'input')) {
        const placeholder = input.placeholder;
        if (!passwordField && LABEL_PASSWORD_PATTERN.test(placeholder)) {
            passwordField = input;
        } else if (!usernameField && LABEL_USERNAME_PATTERN.test(placeholder)) {
            usernameField = input;
        }
    }
    return present(usernameField, passwordField);
}

function present(
    usernameField: HTMLInputElement | undefined,
    passwordField: HTMLInputElement | undefined
): DetectedLoginForm | undefined {
    return usernameField || passwordField ? { usernameField, passwordField } : undefined;
}

function query(root: ParentNode, selector: string): HTMLInputElement | undefined {
    const el = root.querySelector(selector);
    return el instanceof HTMLInputElement ? el : undefined;
}

function queryAll(root: ParentNode, selector: string): HTMLInputElement[] {
    return Array.from(root.querySelectorAll(selector)).filter(
        (el): el is HTMLInputElement => el instanceof HTMLInputElement
    );
}
