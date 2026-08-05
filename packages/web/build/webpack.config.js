import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CopyPlugin from 'copy-webpack-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

/**
 * §10.1's five bundles (background/content/popup/manager/options) plus a
 * temporary dev-harness bundle for Phase 2 — only background and dev-harness
 * exist yet; the rest are added as their phases start.
 *
 * Two separate configs, not one with multiple entries: background.js runs in
 * the service worker (target: 'webworker' — no `document`, no DOM), while
 * dev-harness is a regular extension page (target: 'web'). Webpack's `target`
 * is config-wide, not per-entry, so they can't share one.
 */
export default (_env, argv) => {
    const isProduction = argv.mode === 'production';
    const mode = isProduction ? 'production' : 'development';
    const devtool = isProduction ? false : 'source-map';
    const outputPath = path.join(rootDir, 'dist/chrome');

    const tsRule = {
        test: /\.ts$/,
        use: {
            loader: 'ts-loader',
            options: { configFile: path.join(rootDir, 'tsconfig.json') }
        },
        exclude: /node_modules/
    };

    return [
        {
            name: 'background',
            entry: path.join(rootDir, 'src/background/index.ts'),
            output: { path: outputPath, filename: 'background.js' },
            target: 'webworker',
            resolve: { extensions: ['.ts', '.js'] },
            module: { rules: [tsRule] },
            plugins: [
                new CopyPlugin({
                    patterns: [
                        {
                            from: path.join(rootDir, 'manifests/manifest.chrome.json'),
                            to: 'manifest.json'
                        },
                        // Pulled straight from the pinned `argon2-browser` dependency
                        // (guaranteed present after `pnpm install` — pnpm always gives
                        // a direct dependency a real, directly-accessible entry under
                        // the dependent package's own node_modules) rather than a
                        // vendored copy in the source tree — copying at build time
                        // means it can't silently drift from whatever version
                        // package.json/pnpm-lock.yaml actually pin.
                        {
                            from: path.join(rootDir, 'node_modules/argon2-browser/dist/argon2.js'),
                            to: 'wasm/argon2/argon2.js'
                        },
                        {
                            from: path.join(rootDir, 'node_modules/argon2-browser/dist/argon2.wasm'),
                            to: 'wasm/argon2/argon2.wasm'
                        }
                    ]
                })
            ],
            devtool,
            mode
        },
        {
            name: 'dev-harness',
            entry: path.join(rootDir, 'src/dev-harness/index.ts'),
            output: { path: outputPath, filename: 'dev-harness/index.js' },
            target: 'web',
            resolve: { extensions: ['.ts', '.js'] },
            module: { rules: [tsRule] },
            plugins: [
                new CopyPlugin({
                    patterns: [
                        {
                            from: path.join(rootDir, 'src/dev-harness/index.html'),
                            to: 'dev-harness/index.html'
                        }
                    ]
                })
            ],
            devtool,
            mode
        }
    ];
};
