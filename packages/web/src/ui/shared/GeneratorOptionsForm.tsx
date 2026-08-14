import { DefaultSymbolCharacters, type PassphraseGeneratorOptions, type PasswordGeneratorOptions } from '@keetar/core';

export type GeneratorMode = 'characters' | 'passphrase';

// Controlled form shared by PasswordGeneratorPanel (session state) and Options (saved defaults).
export function GeneratorOptionsForm({
    mode,
    onModeChange,
    passwordOptions,
    onPasswordOptionsChange,
    passphraseOptions,
    onPassphraseOptionsChange
}: {
    mode: GeneratorMode;
    onModeChange: (mode: GeneratorMode) => void;
    passwordOptions: PasswordGeneratorOptions;
    onPasswordOptionsChange: (options: PasswordGeneratorOptions) => void;
    passphraseOptions: PassphraseGeneratorOptions;
    onPassphraseOptionsChange: (options: PassphraseGeneratorOptions) => void;
}) {
    return (
        <>
            <div className="password-generator-mode">
                <button
                    type="button"
                    className={mode === 'characters' ? 'selected' : ''}
                    onClick={() => onModeChange('characters')}
                >
                    Characters
                </button>
                <button
                    type="button"
                    className={mode === 'passphrase' ? 'selected' : ''}
                    onClick={() => onModeChange('passphrase')}
                >
                    Passphrase
                </button>
            </div>

            {mode === 'characters' ? (
                <div className="password-generator-options">
                    <label>
                        Length
                        <input
                            type="number"
                            min={1}
                            max={128}
                            value={passwordOptions.length}
                            onChange={(e) =>
                                onPasswordOptionsChange({
                                    ...passwordOptions,
                                    length: Number(e.target.value) || 1
                                })
                            }
                        />
                    </label>
                    <label>
                        <input
                            type="checkbox"
                            checked={passwordOptions.useLowercase}
                            onChange={(e) =>
                                onPasswordOptionsChange({ ...passwordOptions, useLowercase: e.target.checked })
                            }
                        />
                        a-z
                    </label>
                    <label>
                        <input
                            type="checkbox"
                            checked={passwordOptions.useUppercase}
                            onChange={(e) =>
                                onPasswordOptionsChange({ ...passwordOptions, useUppercase: e.target.checked })
                            }
                        />
                        A-Z
                    </label>
                    <label>
                        <input
                            type="checkbox"
                            checked={passwordOptions.useDigits}
                            onChange={(e) =>
                                onPasswordOptionsChange({ ...passwordOptions, useDigits: e.target.checked })
                            }
                        />
                        0-9
                    </label>
                    <label>
                        <input
                            type="checkbox"
                            checked={passwordOptions.useSymbols}
                            onChange={(e) =>
                                onPasswordOptionsChange({ ...passwordOptions, useSymbols: e.target.checked })
                            }
                        />
                        !@#
                    </label>
                    {passwordOptions.useSymbols && (
                        <div className="password-generator-symbols-row">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={passwordOptions.symbols !== undefined}
                                    onChange={(e) =>
                                        onPasswordOptionsChange({
                                            ...passwordOptions,
                                            symbols: e.target.checked ? DefaultSymbolCharacters : undefined
                                        })
                                    }
                                />
                                Custom symbols
                            </label>
                            <input
                                type="text"
                                disabled={passwordOptions.symbols === undefined}
                                value={passwordOptions.symbols ?? DefaultSymbolCharacters}
                                onChange={(e) =>
                                    onPasswordOptionsChange({ ...passwordOptions, symbols: e.target.value })
                                }
                            />
                        </div>
                    )}
                    <label>
                        <input
                            type="checkbox"
                            checked={passwordOptions.excludeAmbiguous}
                            onChange={(e) =>
                                onPasswordOptionsChange({ ...passwordOptions, excludeAmbiguous: e.target.checked })
                            }
                        />
                        Exclude ambiguous (0/O, 1/l/I)
                    </label>
                </div>
            ) : (
                <div className="password-generator-options">
                    <label>
                        Word count
                        <input
                            type="number"
                            min={1}
                            max={20}
                            value={passphraseOptions.wordCount}
                            onChange={(e) =>
                                onPassphraseOptionsChange({
                                    ...passphraseOptions,
                                    wordCount: Number(e.target.value) || 1
                                })
                            }
                        />
                    </label>
                    <label>
                        Separator
                        <input
                            type="text"
                            value={passphraseOptions.separator}
                            onChange={(e) =>
                                onPassphraseOptionsChange({ ...passphraseOptions, separator: e.target.value })
                            }
                        />
                    </label>
                    <label>
                        <input
                            type="checkbox"
                            checked={passphraseOptions.capitalize}
                            onChange={(e) =>
                                onPassphraseOptionsChange({ ...passphraseOptions, capitalize: e.target.checked })
                            }
                        />
                        Capitalize
                    </label>
                    <label>
                        <input
                            type="checkbox"
                            checked={passphraseOptions.includeNumber}
                            onChange={(e) =>
                                onPassphraseOptionsChange({ ...passphraseOptions, includeNumber: e.target.checked })
                            }
                        />
                        Include a number
                    </label>
                </div>
            )}
        </>
    );
}
