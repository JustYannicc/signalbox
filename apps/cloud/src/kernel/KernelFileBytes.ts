import type { Inode, MaybeAsyncStorage, Stat, Storage } from "./storage.ts";
import { kernelFileByteViewStorage } from "./KernelLowerFileSystemStorage.ts";

/** Synchronous byte operations for one inode in a selected file view. */
export interface KernelFileByteAccess {
  stat(): Stat;
  readInto(offset: bigint, target: Uint8Array): number;
  write(offset: bigint, source: Uint8Array): number;
  append(source: Uint8Array): { offset: bigint; bytesWritten: number };
  truncate(size: bigint): void;
  sync(dataOnly: boolean): void;
  release(): void;
}

/** Selects a byte representation while leaving filesystem identity unchanged. */
export interface KernelFileByteView {
  readonly completion: "sync";
  readonly storage: Storage;
  bind(inode: Inode): KernelFileByteAccess;
}

export type KernelFileByteSelection =
  | { readonly kind: "canonical" }
  | { readonly kind: "view"; readonly view: KernelFileByteView };

export const canonicalFileByteSelection: KernelFileByteSelection = Object.freeze({
  kind: "canonical",
});

/** Binds a view only to the exact synchronous storage object it was built for. */
export function bindFileByteAccess(
  selection: KernelFileByteSelection,
  storage: Storage | MaybeAsyncStorage,
  inode: Inode,
): KernelFileByteAccess | undefined {
  if (selection.kind === "canonical") return undefined;
  const viewStorage = kernelFileByteViewStorage(storage, inode);
  if (viewStorage === undefined) return undefined;
  if (selection.view.completion !== "sync" || selection.view.storage !== viewStorage) {
    throw posixError("ENOTSUP");
  }
  return selection.view.bind(inode);
}

function posixError(code: string): Error & { code: string } {
  return Object.assign(new Error(`File byte view is unavailable: ${code}`), { code });
}
