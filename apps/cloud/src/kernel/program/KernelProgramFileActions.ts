import type { AgentOsSpawnFileAction } from "../process/AgentOsProcessActions.ts";
import { runSync } from "../wasi/internal_wasi_calls.ts";
import type { WasiDescriptorTable, WasiDescriptorSpec } from "../wasi/internal_wasi_descriptors.ts";
import { KernelFileSystem } from "../KernelFileSystem.ts";

export function installDescriptor(
  filesystem: KernelFileSystem,
  fd: number,
  spec: WasiDescriptorSpec,
): void {
  const table = filesystem.descriptors;
  const allocated = table.allocate(spec);
  const descriptor = table.take(allocated);
  try {
    if (table.has(fd)) filesystem.close(fd);
    table.put(fd, descriptor);
  } catch (error) {
    if (!table.has(allocated)) table.put(allocated, descriptor);
    throw error;
  }
}

export function applyFileActions(
  filesystem: KernelFileSystem,
  actions: readonly AgentOsSpawnFileAction[],
): void {
  const table = filesystem.descriptors;
  for (const action of actions) {
    switch (action.kind) {
      case "close":
        filesystem.close(action.fd);
        break;
      case "dup2":
        if (action.sourceFd === action.fd) {
          table.get(action.fd).closeOnExec = false;
        } else {
          runSync(table.duplicateTo(action.sourceFd, action.fd, { closeOnExec: false }));
        }
        break;
      case "open":
        openInto(filesystem, action.fd, action.path, action.flags, action.mode);
        break;
      case "chdir":
        filesystem.chdir(action.path);
        break;
      case "fchdir":
        filesystem.fchdir(action.fd);
        break;
      case "closefrom":
        for (const [fd] of Array.from(table.entries())) {
          if (fd >= action.fd) filesystem.close(fd);
        }
        break;
    }
  }
}

function openInto(
  filesystem: KernelFileSystem,
  targetFd: number,
  path: string,
  flags: number,
  mode: number,
): void {
  const table = filesystem.descriptors;
  const openedFd = filesystem.open(path, flags, mode);
  if (openedFd === targetFd) return;

  const opened = table.take(openedFd);
  try {
    if (table.has(targetFd)) filesystem.close(targetFd);
    table.put(targetFd, opened);
  } catch (error) {
    if (!table.has(openedFd)) table.put(openedFd, opened);
    throw error;
  }
}

export function closeAllDescriptors(table: WasiDescriptorTable): void {
  runSync(table.closeAll());
}
