import { pickVaultFile } from '../providers/local-file';
import { getConfiguredVault, setConfiguredVault } from '../config/vault-config';

// Not one of the real UI surfaces (§8) — see index.html's banner. Now stands
// in only for Options' file-selection responsibility (§8.2) — unlocking and
// viewing vault content moved to the real Popup (Phase 3), since Options
// must never touch decrypted vault content either.

const selectedFileEl = document.getElementById('selected-file') as HTMLDivElement;

async function init(): Promise<void> {
    const configured = await getConfiguredVault();
    if (configured) {
        selectedFileEl.textContent = `Selected: ${configured.name}`;
    }
}

document.getElementById('pick-file')?.addEventListener('click', async () => {
    try {
        const { uuid, name } = await pickVaultFile();
        await setConfiguredVault({ uuid, name });
        selectedFileEl.textContent = `Selected: ${name}`;
    } catch (e) {
        selectedFileEl.textContent = `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
});

void init();
