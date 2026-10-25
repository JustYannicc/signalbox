import { KernelFileSystem } from "../../src/kernel/KernelFileSystem.ts";

/** Keeps command descriptor inheritance separate from descriptors opened by the engine. */
export function createProofCommandFilesystem(source: KernelFileSystem) {
  const mapping = [...source.descriptors.entries()]
    .filter(([, descriptor]) => descriptor.kind !== "file")
    .map(([parentFd]) => ({ parentFd, childFd: parentFd }));
  const descriptors = source.descriptors.fork(mapping);
  let filesystem: KernelFileSystem;
  try {
    filesystem = source.fork(descriptors);
  } catch (error) {
    closeTable(descriptors);
    throw error;
  }

  let closed = false;
  return {
    filesystem,
    close() {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      try {
        closeAll(filesystem);
      } catch (error) {
        errors.push(error);
      }
      try {
        filesystem.dispose();
      } catch (error) {
        errors.push(error);
      }
      throwCleanupErrors(errors, "Proof command filesystem cleanup failed");
    },
  };
}

function closeAll(filesystem: KernelFileSystem): void {
  const errors: unknown[] = [];
  for (const [fd] of filesystem.descriptors.entries()) {
    try {
      filesystem.close(fd);
    } catch (error) {
      errors.push(error);
    }
  }
  throwCleanupErrors(errors, "Proof command descriptor cleanup failed");
}

function closeTable(descriptors: KernelFileSystem["descriptors"]): void {
  const cleanup = new KernelFileSystem({ mounts: [], descriptors });
  try {
    closeAll(cleanup);
  } finally {
    cleanup.dispose();
  }
}

function throwCleanupErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}
