import { Kdbx, KdbxCredentials, ProtectedValue } from '@keetar/core';

// Backend-agnostic empty vault creation (chat-requested)—bytes identical regardless of FileProvider.
export async function createEmptyVaultBytes(name: string, password: string): Promise<ArrayBuffer> {
    const credentials = new KdbxCredentials(ProtectedValue.fromString(password));
    const db = Kdbx.create(credentials, name);
    return db.save();
}
