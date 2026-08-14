import { secureRandomInt } from './secure-random-int.js';
import { EFF_LARGE_WORDLIST } from './eff-large-wordlist.js';

export interface PassphraseGeneratorOptions {
    wordCount: number;
    separator?: string;
    capitalize?: boolean;
    includeNumber?: boolean;
}

const DefaultOptions: Required<PassphraseGeneratorOptions> = {
    wordCount: 6,
    separator: '-',
    capitalize: true,
    includeNumber: false
};

export function generatePassphrase(options?: Partial<PassphraseGeneratorOptions>): string {
    const opts: Required<PassphraseGeneratorOptions> = { ...DefaultOptions, ...options };
    if (opts.wordCount < 1) {
        throw new Error('Passphrase word count must be at least 1');
    }

    const words: string[] = [];
    for (let i = 0; i < opts.wordCount; i++) {
        const word = EFF_LARGE_WORDLIST[secureRandomInt(EFF_LARGE_WORDLIST.length)];
        words.push(opts.capitalize ? capitalizeWord(word) : word);
    }

    if (opts.includeNumber) {
        const wordIndex = secureRandomInt(words.length);
        words[wordIndex] += String(secureRandomInt(10));
    }

    return words.join(opts.separator);
}

function capitalizeWord(word: string): string {
    return word.charAt(0).toUpperCase() + word.slice(1);
}
