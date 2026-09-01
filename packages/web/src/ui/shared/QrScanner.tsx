import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';

// Screen-share QR scan (the code is on screen, e.g. a site's 2FA setup page) — decodes each
// captured frame via jsQR until a code is found or the user cancels/stops sharing.
export function QrScanner({ onDecoded, onCancel }: { onDecoded: (text: string) => void; onCancel: () => void }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [error, setError] = useState<string | undefined>(undefined);

    useEffect(() => {
        let stream: MediaStream | undefined;
        let frameHandle: number | undefined;
        let cancelled = false;

        function scanFrame(): void {
            const video = videoRef.current;
            const canvas = canvasRef.current;
            if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
                frameHandle = requestAnimationFrame(scanFrame);
                return;
            }
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const context = canvas.getContext('2d');
            if (!context) {
                frameHandle = requestAnimationFrame(scanFrame);
                return;
            }
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
            const result = jsQR(imageData.data, imageData.width, imageData.height);
            if (result?.data) {
                onDecoded(result.data);
                return;
            }
            frameHandle = requestAnimationFrame(scanFrame);
        }

        async function start(): Promise<void> {
            try {
                stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
                if (cancelled) {
                    stream.getTracks().forEach((track) => track.stop());
                    return;
                }
                // The browser's own "Stop sharing" control ends the track without unmounting us.
                stream.getVideoTracks()[0]?.addEventListener('ended', () => {
                    if (!cancelled) {
                        onCancel();
                    }
                });
                const video = videoRef.current;
                if (!video) {
                    return;
                }
                video.srcObject = stream;
                await video.play();
                frameHandle = requestAnimationFrame(scanFrame);
            } catch (e) {
                setError(e instanceof Error ? e.message : 'Could not capture the screen.');
            }
        }
        void start();

        return () => {
            cancelled = true;
            if (frameHandle !== undefined) {
                cancelAnimationFrame(frameHandle);
            }
            stream?.getTracks().forEach((track) => track.stop());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className="qr-scanner">
            <p className="qr-scanner-hint">Select the window or tab showing the QR code.</p>
            <video ref={videoRef} className="qr-scanner-video" muted />
            <canvas ref={canvasRef} hidden />
            {error && <p className="qr-scanner-error">{error}</p>}
            <button type="button" onClick={onCancel}>
                Cancel
            </button>
        </div>
    );
}
