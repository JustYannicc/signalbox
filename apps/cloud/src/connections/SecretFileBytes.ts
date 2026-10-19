import type { KernelFileByteAccess, KernelFileByteView } from "../kernel/KernelFileBytes.ts";
import type { Inode, Storage } from "../kernel/storage.ts";
import {
  appendSecretFile,
  mutateSecretFile,
  readSecretFile,
  statSecretFile,
  validateRange,
  validateSize,
  type SecretFileMutation,
} from "./internal/secretFiles/mutation.ts";
import {
  MAX_SECRET_FILE_BYTES,
  prepareSecretBindings,
  secretFileError,
  type SecretFileBindingInput,
} from "./internal/secretFiles/projection.ts";

export interface CanonicalFileTransactions {
  readonly storage: Storage;
  run<T>(operation: (canonical: Storage) => T): T;
}

export interface SecretFileByteViewOptions {
  readonly canonical: Storage;
  readonly transactions: CanonicalFileTransactions;
  /** Resolved before raw execution; the byte view never performs vault or network lookups. */
  readonly bindings: ReadonlyArray<SecretFileBindingInput>;
}

/** App-owned fill/scrub projection over one canonical synchronous Storage identity. */
export function createSecretFileByteView(options: SecretFileByteViewOptions): KernelFileByteView {
  const { canonical, transactions } = options;
  if (
    canonical === null ||
    typeof canonical !== "object" ||
    transactions === null ||
    typeof transactions !== "object" ||
    transactions.storage !== canonical ||
    typeof transactions.run !== "function"
  ) {
    throw secretFileError("ENOTSUP");
  }
  const prepared = prepareSecretBindings(options.bindings);

  return {
    completion: "sync",
    storage: canonical,
    bind(inode: Inode): KernelFileByteAccess {
      transaction((storage) => {
        const stat = storage.stat(inode);
        if (stat.type === "directory") throw secretFileError("EISDIR");
        if (stat.type !== "file") throw secretFileError("EINVAL");
        validateSize(stat.size);
      });
      let released = false;
      const assertOpen = () => {
        if (released) throw secretFileError("EBADF");
      };

      return {
        stat() {
          assertOpen();
          return transaction((storage) => statSecretFile(storage, inode, prepared));
        },
        readInto(offset, target) {
          assertOpen();
          validateRange(offset, BigInt(target.byteLength));
          return transaction((storage) => readSecretFile(storage, inode, prepared, offset, target));
        },
        write(offset, source) {
          assertOpen();
          validateRange(offset, BigInt(source.byteLength));
          if (source.byteLength > MAX_SECRET_FILE_BYTES) throw secretFileError("ENOMEM");
          const mutation: SecretFileMutation = { kind: "write", offset, source };
          return transaction((storage) => mutateSecretFile(storage, inode, prepared, mutation));
        },
        append(source) {
          assertOpen();
          if (source.byteLength > MAX_SECRET_FILE_BYTES) throw secretFileError("ENOMEM");
          return transaction((storage) => appendSecretFile(storage, inode, prepared, source));
        },
        truncate(size) {
          assertOpen();
          validateSize(size);
          const mutation: SecretFileMutation = { kind: "truncate", size };
          transaction((storage) => mutateSecretFile(storage, inode, prepared, mutation));
        },
        sync(dataOnly) {
          assertOpen();
          canonical.sync(inode, dataOnly);
        },
        release() {
          if (released) return;
          released = true;
        },
      };
    },
  };

  function transaction<A>(operation: (storage: Storage) => A): A {
    return transactions.run((storage) => {
      if (storage !== canonical) throw secretFileError("ENOTSUP");
      return operation(storage);
    });
  }
}
