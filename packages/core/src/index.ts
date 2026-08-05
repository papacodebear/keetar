import * as SessionKey from './auth/session-key.js';
import { ChaCha20 } from './crypto/chacha20.js';
import * as CryptoEngine from './crypto/crypto-engine.js';
import * as HmacBlockTransform from './crypto/hmac-block-transform.js';
import * as KeyEncryptorKdf from './crypto/key-encryptor-kdf.js';
import { ProtectSaltGenerator } from './crypto/protect-salt-generator.js';
import { ProtectedValue } from './crypto/protected-value.js';

import * as Consts from './defs/consts.js';
import * as XmlNames from './defs/xml-names.js';

import { KdbxError } from './errors/kdbx-error.js';

import { Kdbx } from './kdbx/kdbx.js';
import { KdbxBinaries } from './kdbx/kdbx-binaries.js';
import { KdbxContext } from './kdbx/kdbx-context.js';
import { KdbxCredentials } from './kdbx/kdbx-credentials.js';
import { KdbxCustomData } from './kdbx/kdbx-custom-data.js';
import { KdbxDeletedObject } from './kdbx/kdbx-deleted-object.js';
import { KdbxEntry } from './kdbx/kdbx-entry.js';
import { KdbxFormat } from './kdbx/kdbx-format.js';
import { KdbxGroup } from './kdbx/kdbx-group.js';
import { KdbxHeader } from './kdbx/kdbx-header.js';
import { KdbxMeta } from './kdbx/kdbx-meta.js';
import { KdbxTimes } from './kdbx/kdbx-times.js';
import { KdbxUuid } from './kdbx/kdbx-uuid.js';

import { BinaryStream } from './utils/binary-stream.js';
import * as ByteUtils from './utils/byte-utils.js';
import { Int64 } from './utils/int64.js';
import { VarDictionary } from './utils/var-dictionary.js';
import * as XmlUtils from './utils/xml-utils.js';

export {
    SessionKey,
    ChaCha20,
    CryptoEngine,
    HmacBlockTransform,
    KeyEncryptorKdf,
    ProtectSaltGenerator,
    ProtectedValue,
    Consts,
    XmlNames,
    KdbxError,
    Kdbx,
    KdbxBinaries,
    KdbxContext,
    KdbxCredentials,
    KdbxCredentials as Credentials,
    KdbxCustomData,
    KdbxDeletedObject,
    KdbxEntry,
    KdbxFormat,
    KdbxGroup,
    KdbxHeader,
    KdbxMeta,
    KdbxTimes,
    KdbxUuid,
    BinaryStream,
    ByteUtils,
    Int64,
    VarDictionary,
    XmlUtils
};

export type { KdbxEditState } from './kdbx/kdbx.js';
export type {
    KdbxBinary,
    KdbxBinaryIn,
    KdbxBinaryOrRef,
    KdbxBinaryRef,
    KdbxBinaryRefWithValue,
    KdbxBinaryWithHash
} from './kdbx/kdbx-binaries.js';
export type { KdbxChallengeResponseFn } from './kdbx/kdbx-credentials.js';
export type { KdbxCustomDataMap, KdbxCustomDataItem } from './kdbx/kdbx-custom-data.js';
export type {
    KdbxAutoTypeItem,
    KdbxEntryAutoType,
    KdbxEntryEditState,
    KdbxEntryField
} from './kdbx/kdbx-entry.js';
export type {
    KdbxMemoryProtection,
    KdbxMetaEditState,
    KdbxCustomIcon
} from './kdbx/kdbx-meta.js';
export type { FileProvider, FileMetadata, FileListing } from './providers/file-provider.js';
