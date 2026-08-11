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
    similarEntryUuids: string[];
}

export interface PasswordHealthReport {
    findings: PasswordHealthFinding[];
    total: number;
    weak: number;
    reused: number;
    old: number;
    breached: number;
    similar: number;
}

export type PasswordBreachChecker = (password: string) => Promise<number>;

const PASSWORD_MAX_AGE_DAYS = 365;
const WEAK_PASSWORD_ENTROPY_BITS = 75;
const ZXCVBN_ESTIMATE_THRESHOLD = 256;
// Edit-distance ratio above which two distinct passwords count as "similar" (1.0 = identical, already covered by reused).
const SIMILAR_PASSWORD_THRESHOLD = 0.7;

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

    const similarEntryUuids = findSimilarPasswordPairs(entries);

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
            breachCount,
            similarEntryUuids: Array.from(similarEntryUuids.get(entry.uuid) ?? [])
        };
    }));

    return {
        findings: findings.filter(
            (finding) => finding.weak || finding.reused || finding.old || finding.breachCount > 0 || finding.similarEntryUuids.length > 0
        ),
        total: entries.length,
        weak: findings.filter((finding) => finding.weak).length,
        reused: findings.filter((finding) => finding.reused).length,
        old: findings.filter((finding) => finding.old).length,
        breached: findings.filter((finding) => finding.breachCount > 0).length,
        similar: findings.filter((finding) => finding.similarEntryUuids.length > 0).length
    };
}

// O(n^2) pairwise comparison — fine for real-world vault sizes, skipped early via a cheap length-ratio bound.
function findSimilarPasswordPairs(entries: PasswordHealthEntry[]): Map<string, Set<string>> {
    const similar = new Map<string, Set<string>>();
    const withPasswords = entries.filter((entry) => entry.password);

    function link(uuidA: string, uuidB: string): void {
        (similar.get(uuidA) ?? similar.set(uuidA, new Set<string>()).get(uuidA)!).add(uuidB);
        (similar.get(uuidB) ?? similar.set(uuidB, new Set<string>()).get(uuidB)!).add(uuidA);
    }

    for (let i = 0; i < withPasswords.length; i++) {
        for (let j = i + 1; j < withPasswords.length; j++) {
            const a = withPasswords[i];
            const b = withPasswords[j];
            if (a.password === b.password) {
                continue; // identical passwords are already reported as "reused"
            }
            const maxLen = Math.max(a.password.length, b.password.length);
            // Even a perfect-overlap edit distance can't clear the threshold at this length gap — skip the DP.
            if (Math.abs(a.password.length - b.password.length) / maxLen > 1 - SIMILAR_PASSWORD_THRESHOLD) {
                continue;
            }
            if (1 - levenshteinDistance(a.password, b.password) / maxLen >= SIMILAR_PASSWORD_THRESHOLD) {
                link(a.uuid, b.uuid);
            }
        }
    }
    return similar;
}

function levenshteinDistance(a: string, b: string): number {
    let previousRow = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const currentRow = [i];
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            currentRow.push(Math.min(previousRow[j] + 1, currentRow[j - 1] + 1, previousRow[j - 1] + cost));
        }
        previousRow = currentRow;
    }
    return previousRow[b.length];
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