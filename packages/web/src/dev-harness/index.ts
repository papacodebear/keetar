import { pickVaultFile } from '../providers/local-file';
import { sendToBackground } from '../background/message-bus';
import { storage } from '../platform';

// Not one of the real UI surfaces (§8) — see index.html's banner.

const STORAGE_KEY = 'devHarnessVault';

const statusEl = document.getElementById('status') as HTMLSpanElement;
const selectedFileEl = document.getElementById('selected-file') as HTMLDivElement;
const passwordEl = document.getElementById('password') as HTMLInputElement;
const outputEl = document.getElementById('output') as HTMLPreElement;

let configuredVault: { uuid: string; name: string } | undefined;

function showOutput(value: unknown): void {
    outputEl.textContent = JSON.stringify(value, null, 2);
}

async function refreshStatus(): Promise<void> {
    const response = await sendToBackground({ type: 'GET_STATUS' });
    statusEl.textContent =
        response.ok && response.type === 'GET_STATUS' ? response.status : `error: ${JSON.stringify(response)}`;
}

async function init(): Promise<void> {
    configuredVault = await storage.get(STORAGE_KEY);
    if (configuredVault) {
        selectedFileEl.textContent = `Selected: ${configuredVault.name}`;
    }
    await refreshStatus();
}

document.getElementById('pick-file')?.addEventListener('click', async () => {
    try {
        const { uuid, name } = await pickVaultFile();
        configuredVault = { uuid, name };
        await storage.set(STORAGE_KEY, configuredVault);
        selectedFileEl.textContent = `Selected: ${name}`;
    } catch (e) {
        showOutput({ error: e instanceof Error ? e.message : String(e) });
    }
});

document.getElementById('unlock')?.addEventListener('click', async () => {
    if (!configuredVault) {
        showOutput({ error: 'select a vault file first' });
        return;
    }
    const response = await sendToBackground({
        type: 'UNLOCK_VAULT',
        uuid: configuredVault.uuid,
        password: passwordEl.value
    });
    showOutput(response);
    await refreshStatus();
});

document.getElementById('lock')?.addEventListener('click', async () => {
    const response = await sendToBackground({ type: 'LOCK_VAULT' });
    showOutput(response);
    await refreshStatus();
});

void init();
