import { useEffect, useState } from 'react';
import { sendToBackground } from '../../background/message-bus';

// Render built-in KeePass icons (0–68) or custom vault icons via background (§9).
export function EntryIcon({
    entryUuid,
    icon,
    hasCustomIcon,
    size = 20
}: {
    entryUuid: string;
    icon: number;
    hasCustomIcon: boolean;
    size?: number;
}) {
    const [customIconDataUrl, setCustomIconDataUrl] = useState<string | undefined>(undefined);
    const [builtInFailed, setBuiltInFailed] = useState(false);

    useEffect(() => {
        setCustomIconDataUrl(undefined);
        if (!hasCustomIcon) {
            return;
        }
        let cancelled = false;
        void sendToBackground({ type: 'GET_ENTRY_CUSTOM_ICON', entryUuid }).then((response) => {
            if (!cancelled && response.ok && response.type === 'GET_ENTRY_CUSTOM_ICON') {
                setCustomIconDataUrl(`data:image/png;base64,${response.dataBase64}`);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [entryUuid, hasCustomIcon]);

    useEffect(() => {
        setBuiltInFailed(false);
    }, [icon]);

    if (hasCustomIcon && customIconDataUrl) {
        return <img src={customIconDataUrl} width={size} height={size} className="entry-icon" alt="" />;
    }

    if (!builtInFailed) {
        return (
            <img
                src={chrome.runtime.getURL(`icons/${icon}.png`)}
                width={size}
                height={size}
                className="entry-icon"
                alt=""
                onError={() => setBuiltInFailed(true)}
            />
        );
    }

    return (
        <span
            className="entry-icon entry-icon-fallback"
            style={{ width: size, height: size }}
            aria-hidden="true"
        />
    );
}
