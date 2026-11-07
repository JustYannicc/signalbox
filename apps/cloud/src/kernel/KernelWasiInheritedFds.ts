import type { KernelFileSystem } from "./KernelFileSystem.ts";

const prepared = new WeakSet<KernelFileSystem["descriptors"]>();

/** Stock wasi-libc discovers contiguous preopens starting at 3, before opening files. */
export function prepareWasiInheritedFds(
  filesystem: KernelFileSystem,
  options: { readonly contiguousPreopens?: boolean } = {},
): void {
  const table = filesystem.descriptors;
  if (prepared.has(table)) return;
  const handles = [...table.entries()];
  if (
    !options.contiguousPreopens &&
    !handles.some(([, descriptor]) => descriptor.posixFd !== undefined)
  )
    return;
  prepared.add(table);
  const movable = handles.filter(([fd]) => fd >= 3);
  const posix = movable
    .filter(([, descriptor]) => !descriptor.preopen)
    .map(([fd, descriptor]) => ({ descriptor, fd: descriptor.posixFd ?? fd }));
  for (const [fd] of movable) table.take(fd);
  movable.sort(
    ([a, left], [b, right]) =>
      Number(Boolean(right.preopen)) - Number(Boolean(left.preopen)) || a - b,
  );
  let next = 3;
  for (const [, descriptor] of movable) table.put(next++, descriptor);
  // put() clears numeric aliases while moving handles; restore them after the table settles.
  for (const { descriptor, fd } of posix) descriptor.posixFd = fd;
}
