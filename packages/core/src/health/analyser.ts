export interface PasswordHealthEntry {
    uuid: string;
    title: string;
    password: string;
    lastModified?: Date;
}

export interface PasswordHealthFinding {
    entryUuid: string;
    title: string;
    entropy: number;
    weak: boolean;
    reused: boolean;
    old: boolean;
    breachCount: number;
}

export interface PasswordHealthReport {
    findings: PasswordHealthFinding[];
    total: number;
    weak: number;
    reused: number;
    old: number;
    breached: number;
}

export type PasswordBreachChecker = (password: string) => Promise<number>;

const PASSWORD_MAX_AGE_DAYS = 365;
const WEAK_PASSWORD_ENTROPY_BITS = 75;
const ZXCVBN_ESTIMATE_THRESHOLD = 256;

type Zxcvbn = (password: string) => { guesses: number };

let zxcvbnPromise: Promise<Zxcvbn> | undefined;

export async function analysePasswordHealth(
    entries: PasswordHealthEntry[],
    checkPasswordBreach: PasswordBreachChecker,
    now = new Date()
): Promise<PasswordHealthReport> {
    const passwordCounts = new Map<string, number>();
    for (const entry of entries) {
        if (entry.password) {
            passwordCounts.set(entry.password, (passwordCounts.get(entry.password) ?? 0) + 1);
        }
    }

    const breachCounts = new Map<string, number>();
    await Promise.all(
        Array.from(passwordCounts.keys()).map(async (password) => {
            breachCounts.set(password, await checkPasswordBreach(password));
        })
    );

    const findings = await Promise.all(entries.map(async (entry) => {
        const breachCount = entry.password ? (breachCounts.get(entry.password) ?? 0) : 0;
        const entropy = await estimatePasswordEntropy(entry.password);
        return {
            entryUuid: entry.uuid,
            title: entry.title,
            entropy,
            weak: entropy < WEAK_PASSWORD_ENTROPY_BITS,
            reused: (passwordCounts.get(entry.password) ?? 0) > 1,
            old: isOld(entry.lastModified, now),
            breachCount
        };
    }));

    return {
        findings: findings.filter((finding) => finding.weak || finding.reused || finding.old || finding.breachCount > 0),
        total: entries.length,
        weak: findings.filter((finding) => finding.weak).length,
        reused: findings.filter((finding) => finding.reused).length,
        old: findings.filter((finding) => finding.old).length,
        breached: findings.filter((finding) => finding.breachCount > 0).length
    };
}

export async function estimatePasswordEntropy(password: string): Promise<number> {
    if (!password) {
        return 0;
    }
    const estimatedPassword = password.slice(0, ZXCVBN_ESTIMATE_THRESHOLD);
    const zxcvbn = await loadZxcvbn();
    const entropy = Math.log2(zxcvbn(estimatedPassword).guesses);
    if (password.length <= ZXCVBN_ESTIMATE_THRESHOLD) {
        return entropy;
    }
    return entropy + (entropy / ZXCVBN_ESTIMATE_THRESHOLD) * (password.length - ZXCVBN_ESTIMATE_THRESHOLD);
}

export async function preloadPasswordStrength(): Promise<void> {
    await loadZxcvbn();
}

function loadZxcvbn(): Promise<Zxcvbn> {
    zxcvbnPromise ??= import(/* webpackChunkName: "zxcvbn" */ 'zxcvbn').then((module) => {
        const imported = module as unknown as { default?: Zxcvbn };
        return imported.default ?? (module as unknown as Zxcvbn);
    });
    return zxcvbnPromise;
}

function isOld(lastModified: Date | undefined, now: Date): boolean {
    if (!lastModified || Number.isNaN(lastModified.getTime())) {
        return false;
    }
    return now.getTime() - lastModified.getTime() >= PASSWORD_MAX_AGE_DAYS * 24 * 60 * 60 * 1_000;
}