import type { KernelFileSystem } from "./KernelFileSystem.ts";

const prepared = new WeakSet<KernelFileSystem["descriptors"]>();

/** Stock wasi-libc discovers contiguous preopens starting at 3, before opening files. */
export function prepareWasiInheritedFds(filesystem: KernelFileSystem): void {
  const table = filesystem.descriptors;
  if (prepared.has(table)) return;
  const handles = [...table.entries()];
  if (!handles.some(([, descriptor]) => descriptor.posixFd !== undefined)) return;
  prepared.add(table);
  const movable = handles.filter(([fd]) => fd >= 3);
  for (const [fd] of movable) table.take(fd);
  movable.sort(
    ([a, left], [b, right]) =>
      Number(Boolean(right.preopen)) - Number(Boolean(left.preopen)) || a - b,
  );
  let next = 3;
  for (const [, descriptor] of movable) table.put(next++, descriptor);
}
