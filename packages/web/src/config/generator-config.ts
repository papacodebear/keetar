import { storage } from '../platform';
import type { PassphraseGeneratorOptions, PasswordGeneratorOptions } from '@keetar/core';

export interface GeneratorPreferences {
    mode: 'characters' | 'passphrase';
    password: PasswordGeneratorOptions;
    passphrase: PassphraseGeneratorOptions;
}

const STORAGE_KEY = 'keetar.generatorPreferences';

export const DefaultGeneratorPreferences: GeneratorPreferences = {
    mode: 'characters',
    password: {
        length: 20,
        useLowercase: true,
        useUppercase: true,
        useDigits: true,
        useSymbols: true,
        excludeAmbiguous: false
    },
    passphrase: {
        wordCount: 6,
        separator: '-',
        capitalize: true,
        includeNumber: false
    }
};

export async function getGeneratorPreferences(): Promise<GeneratorPreferences> {
    const stored = await storage.get<Partial<GeneratorPreferences>>(STORAGE_KEY);
    return {
        mode: stored?.mode ?? DefaultGeneratorPreferences.mode,
        password: { ...DefaultGeneratorPreferences.password, ...stored?.password },
        passphrase: { ...DefaultGeneratorPreferences.passphrase, ...stored?.passphrase }
    };
}

export function setGeneratorPreferences(preferences: GeneratorPreferences): Promise<void> {
    return storage.set(STORAGE_KEY, preferences);
}
