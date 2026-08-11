// DOM heuristics for login form detection; strategies ordered by reliability (§5.2).

export interface DetectedLoginForm {
    usernameField?: HTMLInputElement;
    passwordField?: HTMLInputElement;
}

type Strategy = (root: ParentNode) => DetectedLoginForm | undefined;

const NAME_ID_PASSWORD_PATTERN = /pass|pwd|credential/i;
const NAME_ID_USERNAME_PATTERN = /user|login|email/i;
const LABEL_PASSWORD_PATTERN = /password/i;
const LABEL_USERNAME_PATTERN = /username|e-?mail/i;

// Detect form; username-only result valid for multi-step flows (§5.2).
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

export function detectOneTimeCodeField(root: ParentNode = document): HTMLInputElement | undefined {
    const autocompleteField = query(root, 'input[autocomplete="one-time-code"]');
    if (autocompleteField) {
        return autocompleteField;
    }
    return queryAll(root, 'input[maxlength="6"], input[maxlength="7"], input[maxlength="8"]').find(
        (field) => field.getClientRects().length > 0
    );
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

// Text + password proximity; text alone too weak (would match search box; §5.2).
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
    return queryAll(root, selector)[0];
}

function queryAll(root: ParentNode, selector: string): HTMLInputElement[] {
    return Array.from(root.querySelectorAll(selector)).filter(
        (el): el is HTMLInputElement => el instanceof HTMLInputElement && el.getClientRects().length > 0
    );
}
