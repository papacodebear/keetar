import type { PasswordHealthReport } from '@keetar/core';

// A clone's shared password is expected to match its source's — union-find groups entries
// connected by cloning so that expected overlap doesn't count as a "reused password" finding.

export interface CloneAwareEntry {
    uuid: string;
    password: string;
    clonedFromEntryUuid: string | undefined;
}

export function applyCloneAwareness(report: PasswordHealthReport, entries: CloneAwareEntry[]): PasswordHealthReport {
    const componentOf = buildCloneComponents(entries);
    const passwordOf = new Map(entries.map((e) => [e.uuid, e.password]));
    const byPassword = new Map<string, string[]>();
    for (const entry of entries) {
        if (!entry.password) {
            continue;
        }
        const list = byPassword.get(entry.password) ?? [];
        list.push(entry.uuid);
        byPassword.set(entry.password, list);
    }

    const adjusted = report.findings.map((finding) => {
        if (!finding.reused) {
            return finding;
        }
        const password = passwordOf.get(finding.entryUuid);
        const peers = (password ? byPassword.get(password) : undefined)?.filter((uuid) => uuid !== finding.entryUuid) ?? [];
        const explainedByCloning =
            peers.length > 0 && peers.every((uuid) => componentOf.get(uuid) === componentOf.get(finding.entryUuid));
        return explainedByCloning ? { ...finding, reused: false } : finding;
    });
    const findings = adjusted.filter(
        (f) => f.weak || f.reused || f.old || f.breachCount > 0 || f.similarEntryUuids.length > 0
    );

    return {
        findings,
        total: report.total,
        weak: findings.filter((f) => f.weak).length,
        reused: findings.filter((f) => f.reused).length,
        old: findings.filter((f) => f.old).length,
        breached: findings.filter((f) => f.breachCount > 0).length,
        similar: findings.filter((f) => f.similarEntryUuids.length > 0).length
    };
}

function buildCloneComponents(entries: CloneAwareEntry[]): Map<string, string> {
    const parent = new Map<string, string>();
    for (const entry of entries) {
        parent.set(entry.uuid, entry.uuid);
    }

    function find(uuid: string): string {
        let root = uuid;
        while (parent.get(root) !== root) {
            root = parent.get(root)!;
        }
        parent.set(uuid, root);
        return root;
    }

    for (const entry of entries) {
        if (!entry.clonedFromEntryUuid) {
            continue;
        }
        if (!parent.has(entry.clonedFromEntryUuid)) {
            parent.set(entry.clonedFromEntryUuid, entry.clonedFromEntryUuid);
        }
        const rootA = find(entry.uuid);
        const rootB = find(entry.clonedFromEntryUuid);
        if (rootA !== rootB) {
            parent.set(rootA, rootB);
        }
    }

    const componentOf = new Map<string, string>();
    for (const uuid of parent.keys()) {
        componentOf.set(uuid, find(uuid));
    }
    return componentOf;
}
