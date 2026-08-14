/** Credentials captured from a submitted login form. They stay in session-only storage until reviewed. */
export interface CapturedLogin {
    title: string;
    url: string;
    username?: string;
    password?: string;
    /** Every password-type field's value in the submitted form — used to spot a Keetar-generated password. */
    passwordCandidates?: string[];
}

/** Merge consecutive steps in a login flow without replacing a populated value with an empty field. */
export function mergeCapturedLogin(previous: CapturedLogin | undefined, incoming: CapturedLogin): CapturedLogin {
    return {
        title: previous?.title || incoming.title,
        url: previous?.url || incoming.url,
        username: incoming.username || previous?.username,
        password: incoming.password || previous?.password,
        passwordCandidates: [...(previous?.passwordCandidates ?? []), ...(incoming.passwordCandidates ?? [])]
    };
}

export function hasCompleteCapturedLogin(capture: CapturedLogin | undefined): capture is CapturedLogin & {
    username: string;
    password: string;
} {
    return Boolean(capture?.username && capture.password);
}
