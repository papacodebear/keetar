import type { VaultBackend } from '../../config/vault-config';

export function VaultProviderIcon({ provider }: { provider: VaultBackend | undefined }) {
    if (provider === 'gdrive') {
        return (
            <svg className="vault-provider-icon" viewBox="0 0 24 24" role="img" aria-label="Google Drive">
                <path fill="#0F9D58" d="M8.1 2.1h5.4l7 12.1h-5.4z" />
                <path fill="#F4B400" d="M8.1 2.1 1.1 14.2l2.7 4.7 7-12.1z" />
                <path fill="#4285F4" d="M3.8 18.9h14l2.7-4.7h-14z" />
            </svg>
        );
    }

    return (
        <svg className="vault-provider-icon" viewBox="0 0 24 24" role="img" aria-label="Local file">
            <path
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.8"
                d="M6 2.9h7l5 5V21H6zM13 2.9v5h5M9 14h6M9 17.5h6"
            />
        </svg>
    );
}
