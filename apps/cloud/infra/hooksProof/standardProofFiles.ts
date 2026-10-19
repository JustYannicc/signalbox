import { createSecretFileByteView } from "../../src/connections/SecretFileBytes.ts";
import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import type {
  KernelFileByteSelection,
  KernelFileByteView,
} from "../../src/kernel/KernelFileBytes.ts";
import type { Storage } from "../../src/kernel/storage.ts";

/** Public fixture bindings are resolved before this synchronous execution boundary is created. */
export function createStandardProofFiles(input: {
  readonly database: FacetStorage;
  readonly storage: Storage;
  readonly bindings: ReadonlyArray<{ readonly placeholder: string; readonly value: string }>;
  readonly assertActive: () => void;
}) {
  const inner = createSecretFileByteView({
    canonical: input.storage,
    transactions: {
      storage: input.storage,
      run: (operation) =>
        input.database.transactionSync(() => {
          input.assertActive();
          const result = operation(input.storage);
          input.assertActive();
          return result;
        }),
    },
    bindings: input.bindings,
  });
  let reads = 0;
  let bytesRead = 0;
  let mutations = 0;
  const view: KernelFileByteView = {
    ...inner,
    bind(inode) {
      input.assertActive();
      const access = inner.bind(inode);
      return {
        ...access,
        readInto(offset, target) {
          const count = access.readInto(offset, target);
          reads++;
          bytesRead += count;
          return count;
        },
        write(offset, source) {
          const count = access.write(offset, source);
          if (count > 0) mutations++;
          return count;
        },
        append(source) {
          const result = access.append(source);
          if (result.bytesWritten > 0) mutations++;
          return result;
        },
        truncate(size) {
          access.truncate(size);
          mutations++;
        },
      };
    },
  };
  const selection: KernelFileByteSelection = { kind: "view", view };
  return {
    selection,
    inspect: () => ({
      kind: "same-storage-synchronous-secret-byte-view",
      envelope: { canonicalBytes: 1_048_576, rawBytes: 1_048_576, scratchBytes: 4_194_304 },
      reads,
      bytesRead,
      mutations,
    }),
  };
}
