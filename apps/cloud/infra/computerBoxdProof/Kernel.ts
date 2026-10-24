import { KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import type { FacetStorage } from "../../src/kernel/FacetSqliteStorage.ts";
import { createFacetWorkspace } from "../../src/computer/FacetWorkspace.ts";
import { createBoxdProofWorkspace, type BoxdProofVmPort } from "./Workspace.ts";
import type { decodeProofSeed } from "./SeedProtocol.ts";
import { INITIAL_FILE, RESULT_FILE, PROOF_COMMAND, runProofCommand, sameBytes } from "./Command.ts";
import { openProofFilesystem, PROOF_INITIAL_REVISION } from "./Filesystem.ts";
import type { ForkCommit } from "../../src/kernel/FilePersistencePorts.ts";
import { createProofAdmittedCommands } from "./AdmittedCommands.ts";
import { runLocalOnlyControl } from "./LocalOnlyControl.ts";
import type { ChildWorkerLoaderPort } from "../../src/computer/WorkerLoaderDispatch.ts";
import type { BoxdProofMachineIdentityObservation } from "./Identity.ts";

/** One facet SQLite filesystem and durable one-file proof revision repository. */
export function proofKernel(
  database: FacetStorage,
  loader: WorkerLoader | ChildWorkerLoaderPort,
  seed: Awaited<ReturnType<typeof decodeProofSeed>>,
) {
  const state = openProofFilesystem(database);
  const { wakes, ports, persistence, filesystem, write, read } = state;
  const initial = PROOF_INITIAL_REVISION;
  ports.seedFile(initial, "/out.bin", INITIAL_FILE);
  filesystem.mkdir("/bin");
  filesystem.mkdir("/workspace");
  filesystem.chdir("/workspace");
  for (const executable of seed.executables) write(executable.path, executable.bytes, 0o755);
  write("/workspace/out.bin", INITIAL_FILE);
  const admitted = createProofAdmittedCommands({
    filesystem,
    loader,
    programs: seed.programs,
    wakes,
  });
  const host = admitted.host;
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
    escalation: admitted.escalation,
    commands: admitted.commands,
    bindNestedMachine: admitted.bindNestedMachine,
    admissionSnapshot: admitted.snapshot,
    drain: admitted.drain,
    admissionDiagnostics: admitted.admissionDiagnostics,
    settledDiagnostics: admitted.settledDiagnostics,
    async localControl(signal: AbortSignal) {
      await runProofCommand(await admitted.commands.isolate.exec(PROOF_COMMAND, signal, undefined));
      await admitted.drain();
      if (!sameBytes(read(held), RESULT_FILE) || admitted.snapshot().active !== 0)
        throw new Error("Child Dynamic Worker did not settle its file writes and capacity");
      write("/workspace/out.bin", INITIAL_FILE);
      return runLocalOnlyControl(admitted, signal);
    },
    workspace(
      vm: BoxdProofVmPort,
      onMachineIdentity?: (observation: BoxdProofMachineIdentityObservation) => Promise<void>,
    ) {
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
            ...(onMachineIdentity === undefined ? {} : { onMachineIdentity }),
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
      await admitted.close();
      await host.processes.dispose();
      filesystem.close(held);
      state.close();
    },
  };
}
