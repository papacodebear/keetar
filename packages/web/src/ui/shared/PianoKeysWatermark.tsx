const WHITE_KEY_COUNT = 7;
const WHITE_KEY_WIDTH = 20;
const WHITE_KEY_HEIGHT = 70;
const BLACK_KEY_WIDTH = 12;
const BLACK_KEY_HEIGHT = 44;
// Gaps (between white key i and i+1) that get a black key — skips E-F and B-C, like a real keyboard.
const BLACK_KEY_GAPS = [0, 1, 3, 4, 5];

// Purely decorative — entry detail pane watermark, opacity/color set by the caller's CSS.
export function PianoKeysWatermark({ className }: { className?: string }) {
    return (
        <svg
            className={className}
            viewBox={`0 0 ${WHITE_KEY_COUNT * WHITE_KEY_WIDTH} ${WHITE_KEY_HEIGHT}`}
            aria-hidden="true"
            focusable="false"
        >
            {Array.from({ length: WHITE_KEY_COUNT }).map((_, i) => (
                <rect
                    key={`white-${i}`}
                    x={i * WHITE_KEY_WIDTH}
                    y={0}
                    width={WHITE_KEY_WIDTH}
                    height={WHITE_KEY_HEIGHT}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                />
            ))}
            {BLACK_KEY_GAPS.map((gap) => (
                <rect
                    key={`black-${gap}`}
                    x={(gap + 1) * WHITE_KEY_WIDTH - BLACK_KEY_WIDTH / 2}
                    y={0}
                    width={BLACK_KEY_WIDTH}
                    height={BLACK_KEY_HEIGHT}
                    fill="currentColor"
                />
            ))}
        </svg>
    );
}
