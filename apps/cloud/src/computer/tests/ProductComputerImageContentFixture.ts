import { vi } from "vite-plus/test";
import { createKernelSyscallHost } from "../../kernel/KernelSyscallHost.ts";
import { createFacetSqliteStorage } from "../../kernel/FacetSqliteStorage.ts";
import { KernelFileSystem } from "../../kernel/KernelFileSystem.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { CHILD_COREUTILS_COMMANDS } from "../ChildProgramSet.ts";
import type { MachineFilesPort } from "../MachineFilesPort.ts";
import { createProductComputer } from "../ProductComputer.ts";
import { sqliteFixture } from "../sqliteTesting.ts";
import { imageContentInventory } from "./ImageContentFixture.ts";

export async function withImageContentFixture(
  operation: (fixture: ReturnType<typeof imageContentFixture>) => Promise<void>,
  options: Parameters<typeof imageContentFixture>[0] = {},
) {
  const fixture = imageContentFixture(options);
  try {
    await operation(fixture);
  } finally {
    await fixture.close();
  }
}

function imageContentFixture({
  uid = 1000,
  inventory = imageContentInventory(),
}: { readonly uid?: number; readonly inventory?: ReturnType<typeof imageContentInventory> } = {}) {
  const database = sqliteFixture();
  const storage = createFacetSqliteStorage(database.storage, () => 1n);
  storage.posix.initialize(storage.root, { uid, gid: uid, mode: 0o755 });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage }],
    posix: { credentials: { uid, gid: uid, euid: uid, egid: uid }, umask: 0o022 },
  });
  const wakes = new KernelWakeRegistry();
  const forbidden = vi.fn(async () => {
    throw new Error("No machine or command is needed to read image content");
  });
  const code = { mainModule: "unused.js", modules: { "unused.js": "export default class {}" } };
  let state: ReturnType<MachineFilesPort["current"]> = {
    generation: null,
    generationAbsent: true,
    pristine: false,
  };
  const computer = createProductComputer({
    threadId: "image-content-public-composition",
    filesystem,
    wakes,
    capacity: new ChildWorkerCapacity(2, {
      owner: "test/image-content-public-composition",
      RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
    }),
    programs: {
      bash: code,
      busyboxCat: code,
      busyboxApplets: code,
      productBusyboxApplets: code,
      ripgrep: code,
      git: code,
      sed: code,
      jq: code,
      ugrep: code,
      coreutils: Object.fromEntries(CHILD_COREUTILS_COMMANDS.map((name) => [name, code])) as Record<
        (typeof CHILD_COREUTILS_COMMANDS)[number],
        typeof code
      >,
    },
    loader: { run: forbidden },
    machineInventory: inventory,
    machine: () => ({
      files: {
        current: () => state,
        markExecuted: forbidden,
        lookup: forbidden,
      },
      spawn: forbidden,
    }),
    signal: new AbortController().signal,
  });
  const syscalls = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  const open = async (path: string) => {
    const name = new TextEncoder().encode(path);
    return syscalls.call({
      name: "path_open",
      args: [3, 1, 128, name.byteLength, 0, 2n, 0n, 0, 256],
      memorySize: 1024,
      regions: [
        { pointer: 128, bytes: name, direction: "in" },
        { pointer: 256, bytes: new Uint8Array(), direction: "out", length: 4 },
      ],
    });
  };
  return {
    filesystem,
    inventory,
    setState: (next: typeof state) => {
      state = next;
    },
    syscalls,
    forbidden,
    open,
    async close() {
      syscalls.close();
      await computer.close();
      wakes.dispose();
      filesystem.dispose();
      database.close();
    },
  };
}
