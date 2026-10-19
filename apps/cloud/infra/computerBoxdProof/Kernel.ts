// @effect-diagnostics globalDate:off - the real facet SQLite fixture timestamps native writes.
import { KernelProgramRegistry, KernelWakeRegistry } from "../../src/kernel/KernelAbi.ts";
import { KernelProgramHost } from "../../src/kernel/KernelProgramHost.ts";
import { KernelFileSystem, KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import { createFacetFilePersistence } from "../../src/kernel/FacetFilePersistence.ts";
import { createMemoryFilePersistencePorts } from "../../src/kernel/MemoryFilePersistencePorts.ts";
import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { createSeededChildProgramCatalog } from "../childPrograms/runtime.ts";
import { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import { createComputerCommands } from "../../src/computer/ComputerCommands.ts";
import { ComputerEscalationTable } from "../../src/computer/EscalationTable.ts";
import { createFacetWorkspace } from "../../src/computer/FacetWorkspace.ts";
import { createBoxdProofWorkspace, type BoxdProofVmPort } from "./Workspace.ts";
import type { decodeProofSeed } from "./SeedProtocol.ts";
import { INITIAL_FILE, RESULT_FILE, PROOF_COMMAND, runProofCommand, sameBytes } from "./Command.ts";

/** One real facet SQLite filesystem. The revision repository behind its ports is proof-only. */
export function proofKernel(
  database: FacetStorage,
  loader: WorkerLoader,
  seed: Awaited<ReturnType<typeof decodeProofSeed>>,
) {
  const wakes = new KernelWakeRegistry();
  const ports = createMemoryFilePersistencePorts();
  const initial = { repository: "proof-only", fork: "owned-proof", commit: "initial" };
  ports.seedFile(initial, "/out.bin", INITIAL_FILE);
  const persistence = createFacetFilePersistence(database, () => BigInt(Date.now()) * 1_000_000n, {
    wakes,
    ports,
  });
  persistence.storage.posix.initialize(persistence.storage.root, { mode: 0o755, uid: 0, gid: 0 });
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: persistence.storage }],
    posix: { credentials: { uid: 0, gid: 0, euid: 0, egid: 0 }, umask: 0o022 },
  });
  const write = (path: string, bytes: Uint8Array, mode = 0o644) => {
    const descriptor = filesystem.open(
      path,
      KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
      mode,
    );
    try {
      filesystem.write(descriptor, bytes, null);
    } finally {
      filesystem.close(descriptor);
    }
  };
  const read = (descriptor: number) => {
    const bytes = new Uint8Array(Number(filesystem.fstat(descriptor).size));
    const count = filesystem.read(descriptor, bytes, 0n);
    return bytes.subarray(0, count);
  };
  filesystem.mkdir("/bin");
  filesystem.mkdir("/workspace");
  filesystem.chdir("/workspace");
  for (const executable of seed.executables) write(executable.path, executable.bytes, 0o755);
  write("/workspace/out.bin", INITIAL_FILE);
  const registry = new KernelProgramRegistry();
  const capacity = new ChildWorkerCapacity();
  const catalog = createSeededChildProgramCatalog({
    registry,
    filesystem,
    loader,
    capacity,
    programs: seed.programs,
    hostname: "proof-host",
  });
  const host = new KernelProgramHost({ registry, wakes, programs: catalog.bindings });
  const held = filesystem.open("/workspace/out.bin", KernelOpenFlags.O_RDONLY);
  const inode = filesystem.fstat(held).ino;
  return {
    filesystem,
    ports,
    host,
    async localControl(signal: AbortSignal) {
      const commands = createComputerCommands({
        kernel: { host, filesystem },
        escalation: new ComputerEscalationTable(),
        machine: {
          spawn: async () => {
            throw new Error("Local control attempted VM forwarding");
          },
        },
      });
      await runProofCommand(await commands.exec(PROOF_COMMAND, signal));
      await catalog.drain();
      if (!sameBytes(read(held), RESULT_FILE) || capacity.active !== 0)
        throw new Error("Child Dynamic Worker did not settle its file writes and capacity");
      write("/workspace/out.bin", INITIAL_FILE);
    },
    workspace(vm: BoxdProofVmPort) {
      return createFacetWorkspace({
        database,
        persistence,
        filesystem,
        mountPath: "/workspace",
        initial,
        mount: createBoxdProofWorkspace({
          vm,
          trackedFiles: [
            {
              path: "/out.bin",
              inode,
              stat: persistence.storage.stat(inode),
              posix: persistence.storage.posix.get(inode),
            },
          ],
        }),
      });
    },
    assertApplied() {
      if (
        filesystem.fstat(held).ino !== inode ||
        filesystem.stat("/workspace/out.bin").ino !== inode ||
        !sameBytes(read(held), RESULT_FILE)
      ) {
        throw new Error("VM revision did not apply into the original open kernel inode");
      }
      const turns = ports.committedTurns;
      const last = turns.at(-1);
      if (
        !last ||
        last.at.commit === initial.commit ||
        !sameBytes(last.tree["/out.bin"]?.data ?? new Uint8Array(), RESULT_FILE)
      ) {
        throw new Error("Proof revision backing did not retain the command result");
      }
      if (
        !sameBytes(ports.inspectTree(initial)?.["/out.bin"]?.data ?? new Uint8Array(), INITIAL_FILE)
      ) {
        throw new Error("Proof before-revision was mutated");
      }
    },
    async close() {
      await catalog.drain();
      await host.processes.dispose();
      filesystem.close(held);
      filesystem.dispose();
      persistence.dispose();
      wakes.dispose();
    },
  };
}
