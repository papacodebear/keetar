import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CopyPlugin from 'copy-webpack-plugin';
import TerserPlugin from 'terser-webpack-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Five bundles: background, content, popup, manager, options.
// Background's webpack target varies by browser (webworker/web) — controlled via --env browser=firefox.
export default (env, argv) => {
    const isProduction = argv.mode === 'production';
    const mode = isProduction ? 'production' : 'development';
    const devtool = isProduction ? false : 'source-map';
    // --env browser=firefox for Firefox build; defaults to Chrome.
    const browser = env?.browser === 'firefox' ? 'firefox' : 'chrome';
    const outputPath = path.join(rootDir, `dist/${browser}`);
    const backgroundTarget = browser === 'firefox' ? 'web' : 'webworker';

    const tsRule = {
        test: /\.tsx?$/,
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
            target: backgroundTarget,
            resolve: { extensions: ['.tsx', '.ts', '.js'] },
            module: { rules: [tsRule] },
            plugins: [
                new CopyPlugin({
                    patterns: [
                        {
                            from: path.join(rootDir, `manifests/manifest.${browser}.json`),
                            to: 'manifest.json'
                        },
                        // Copy from pinned dependency to prevent version drift.
                        {
                            from: path.join(rootDir, 'node_modules/argon2-browser/dist/argon2.js'),
                            to: 'wasm/argon2/argon2.js'
                        },
                        {
                            from: path.join(rootDir, 'node_modules/argon2-browser/dist/argon2.wasm'),
                            to: 'wasm/argon2/argon2.wasm'
                        },
                        // KeePass icon set (indexed 0..68, partial set OK; fallback in EntryIcon.tsx).
                        {
                            from: path.join(rootDir, 'assets/icons/*.png'),
                            to: 'icons/[name][ext]',
                            noErrorOnMissing: true
                        }
                    ]
                })
            ],
            devtool,
            mode
        },
        {
            name: 'options',
            entry: path.join(rootDir, 'src/ui/options/index.tsx'),
            output: { path: outputPath, filename: 'options/index.js' },
            target: 'web',
            resolve: { extensions: ['.tsx', '.ts', '.js'] },
            module: { rules: [tsRule] },
            plugins: [
                new CopyPlugin({
                    patterns: [
                        {
                            from: path.join(rootDir, 'src/ui/options/options.html'),
                            to: 'options/options.html'
                        },
                        // Google Picker JS from google-picker-offline-loader package; root-relative via chrome.runtime.getURL().
                        {
                            from: path.join(rootDir, 'node_modules/google-picker-offline-loader/vendor/*.js'),
                            to: 'vendor/google-picker/[name][ext]'
                        },
                        // Firefox picker callback page; copied for both browsers (harmless on Chrome).
                        {
                            from: path.join(rootDir, 'src/picker-callback/picker-callback.html'),
                            to: 'picker-callback/picker-callback.html'
                        },
                        {
                            from: path.join(rootDir, 'src/picker-callback/picker-callback.js'),
                            to: 'picker-callback/picker-callback.js'
                        }
                    ]
                })
            ],
            // Exclude vendored Picker JS from minification (bytes validated against API).
            optimization: {
                minimizer: [new TerserPlugin({ exclude: /vendor[\\/]google-picker/ })]
            },
            devtool,
            mode
        },
        {
            // Chrome-only offscreen document (§ Options item 7): the only context an MV3 service
            // worker can delegate navigator.clipboard access to. Harmlessly unused on Firefox.
            name: 'offscreen-clipboard',
            entry: path.join(rootDir, 'src/background/offscreen-clipboard.ts'),
            output: { path: outputPath, filename: 'offscreen-clipboard.js' },
            target: 'web',
            resolve: { extensions: ['.tsx', '.ts', '.js'] },
            module: { rules: [tsRule] },
            plugins: [
                new CopyPlugin({
                    patterns: [
                        {
                            from: path.join(rootDir, 'src/background/offscreen-clipboard.html'),
                            to: 'offscreen-clipboard.html'
                        }
                    ]
                })
            ],
            devtool,
            mode
        },
        {
            name: 'content',
            entry: path.join(rootDir, 'src/autofill/content.ts'),
            output: { path: outputPath, filename: 'content.js' },
            target: 'web',
            resolve: { extensions: ['.tsx', '.ts', '.js'] },
            module: { rules: [tsRule] },
            devtool,
            mode
        },
        {
            // MAIN-world monkey-patch of navigator.credentials — must be its own bundle since it
            // runs in the page's own JS realm, not the isolated content-script world.
            name: 'passkey-shim',
            entry: path.join(rootDir, 'src/passkey-provider/page-shim.ts'),
            output: { path: outputPath, filename: 'passkey-shim.js' },
            target: 'web',
            resolve: { extensions: ['.tsx', '.ts', '.js'] },
            module: { rules: [tsRule] },
            devtool,
            mode
        },
        {
            name: 'passkey-prompt',
            entry: path.join(rootDir, 'src/ui/passkey-prompt/index.tsx'),
            output: { path: outputPath, filename: 'passkey-prompt/index.js' },
            target: 'web',
            resolve: { extensions: ['.tsx', '.ts', '.js'] },
            module: { rules: [tsRule] },
            plugins: [
                new CopyPlugin({
                    patterns: [
                        {
                            from: path.join(rootDir, 'src/ui/passkey-prompt/passkey-prompt.html'),
                            to: 'passkey-prompt/passkey-prompt.html'
                        }
                    ]
                })
            ],
            devtool,
            mode
        },
        {
            name: 'popup',
            entry: path.join(rootDir, 'src/ui/popup/index.tsx'),
            output: { path: outputPath, filename: 'popup/index.js' },
            target: 'web',
            resolve: { extensions: ['.tsx', '.ts', '.js'] },
            module: { rules: [tsRule] },
            plugins: [
                new CopyPlugin({
                    patterns: [
                        {
                            from: path.join(rootDir, 'src/ui/popup/popup.html'),
                            to: 'popup/popup.html'
                        }
                    ]
                })
            ],
            devtool,
            mode
        },
        {
            name: 'manager',
            entry: path.join(rootDir, 'src/ui/manager/index.tsx'),
            output: { path: outputPath, filename: 'manager/index.js' },
            target: 'web',
            resolve: { extensions: ['.tsx', '.ts', '.js'] },
            module: { rules: [tsRule] },
            plugins: [
                new CopyPlugin({
                    patterns: [
                        {
                            from: path.join(rootDir, 'src/ui/manager/manager.html'),
                            to: 'manager/manager.html'
                        }
                    ]
                })
            ],
            devtool,
            mode
        }
    ];
};
