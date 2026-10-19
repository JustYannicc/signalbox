import { KernelProgramRegistry } from "../../src/kernel/KernelAbi.ts";
import { KernelProgramHost } from "../../src/kernel/KernelProgramHost.ts";
import { KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { createSeededChildProgramCatalog } from "../childPrograms/runtime.ts";
import { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import { createComputerCommands } from "../../src/computer/ComputerCommands.ts";
import { ComputerEscalationTable } from "../../src/computer/EscalationTable.ts";
import { createFacetWorkspace } from "../../src/computer/FacetWorkspace.ts";
import { createBoxdProofWorkspace, type BoxdProofVmPort } from "./Workspace.ts";
import type { decodeProofSeed } from "./SeedProtocol.ts";
import { INITIAL_FILE, RESULT_FILE, PROOF_COMMAND, runProofCommand, sameBytes } from "./Command.ts";
import { openProofFilesystem, PROOF_INITIAL_REVISION } from "./Filesystem.ts";
import { createComputerProgramAdmission } from "../../src/computer/ComputerProgramAdmission.ts";
import type { KernelCommandForwarder } from "../../src/kernel/KernelCommandForwarder.ts";
import type { ForkCommit } from "../../src/kernel/FilePersistencePorts.ts";
import { nestedProofEscalation } from "./NestedCommand.ts";

/** One facet SQLite filesystem and durable one-file proof revision repository. */
export function proofKernel(
  database: FacetStorage,
  loader: WorkerLoader,
  seed: Awaited<ReturnType<typeof decodeProofSeed>>,
) {
  const state = openProofFilesystem(database);
  const { wakes, ports, persistence, filesystem, write, read } = state;
  const initial = PROOF_INITIAL_REVISION;
  ports.seedFile(initial, "/out.bin", INITIAL_FILE);
  persistence.storage.posix.initialize(persistence.storage.root, { mode: 0o755, uid: 0, gid: 0 });
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
  let admission: ReturnType<typeof createComputerProgramAdmission> | undefined;
  const escalation = nestedProofEscalation();
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs: catalog.bindings,
    admit: (request) => {
      if (!admission) throw new Error("Nested proof admission is not bound");
      return admission.admit(request);
    },
  });
  // The preflight runs before a machine exists, including every shell descendant.
  const localHost = new KernelProgramHost({
    registry,
    wakes,
    processes: host.processes,
    programs: catalog.bindings,
  });
  const held = filesystem.open(
    "/workspace/out.bin",
    KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_CLOEXEC,
  );
  const inode = filesystem.fstat(held).ino;
  return {
    filesystem,
    ports,
    host,
    inode,
    escalation,
    bindNestedMachine(machine: KernelCommandForwarder) {
      if (admission) throw new Error("Nested proof admission was already bound");
      admission = createComputerProgramAdmission({ escalation, capacity, machine });
    },
    async localControl(signal: AbortSignal) {
      const commands = createComputerCommands({
        kernel: { host: localHost, filesystem },
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
        // The isolate may write before its nested command checkpoints the file.
        mount: (...args) =>
          createBoxdProofWorkspace({
            vm,
            trackedFiles: [
              {
                path: "/out.bin",
                inode,
                stat: persistence.storage.stat(inode),
                posix: persistence.storage.posix.get(inode),
              },
            ],
          })(...args),
      });
    },
    assertApplied(before?: ForkCommit, beforeBytes = INITIAL_FILE) {
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
        last.receipt.commit === initial.commit ||
        !sameBytes(last.tree["/out.bin"]?.data ?? new Uint8Array(), RESULT_FILE)
      ) {
        throw new Error("Proof revision backing did not retain the command result");
      }
      if (
        !sameBytes(
          ports.inspectTree(initial)?.["/out.bin"]?.data ?? new Uint8Array(),
          INITIAL_FILE,
        ) ||
        (before !== undefined &&
          !sameBytes(
            ports.inspectTree(before)?.["/out.bin"]?.data ?? new Uint8Array(),
            beforeBytes,
          ))
      ) {
        throw new Error("Proof before-revision was mutated");
      }
    },
    async close() {
      admission?.close();
      await catalog.drain();
      await host.processes.dispose();
      filesystem.close(held);
      state.close();
    },
  };
}
