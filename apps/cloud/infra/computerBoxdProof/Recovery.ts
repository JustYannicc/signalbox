// @effect-diagnostics globalDate:off - the disposable proof retains its original Base deadline.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ThreadId } from "@t3tools/contracts";
import { createFacetWorkspace } from "../../src/computer/FacetWorkspace.ts";
import { MachineCommands } from "../../src/computer/MachineCommands.ts";
import { createRunnerMachineRuntime } from "../../src/computer/RunnerMachineRuntime.ts";
import { RunnerMachineSockets } from "../../src/computer/RunnerMachineSockets.ts";
import { KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import type { ForkCommit } from "../../src/kernel/FilePersistencePorts.ts";
import { createDurableProofBases } from "./DurableBases.ts";
import { openProofFilesystem, PROOF_INITIAL_REVISION } from "./Filesystem.ts";
import { RESULT_FILE, sameBytes } from "./Command.ts";
import { NESTED_PRIOR_FILE } from "./NestedCommand.ts";
import type { ProofOwnership } from "./Ownership.ts";
import type { ProofRecoveryReceipt } from "./OwnerReplacement.ts";
import { proofProvider, WORKSPACE_RECEIPT } from "./Provider.ts";
import { createBoxdProofWorkspaceResume } from "./Workspace.ts";
import type { proofKernel } from "./Kernel.ts";

export type { ProofRecoveryReceipt } from "./OwnerReplacement.ts";

const sameRevision = (left: ForkCommit | undefined, right: ForkCommit) =>
  left?.repository === right.repository && left.fork === right.fork && left.commit === right.commit;

export function proofRecoveryReceipt(
  ownership: ProofOwnership,
  sourceRef: string,
  kernel: Pick<ReturnType<typeof proofKernel>, "ports" | "filesystem" | "inode">,
): ProofRecoveryReceipt {
  const record = ownership.journal.read(ownership.commandOperation);
  if (
    record?.phase !== "apply" ||
    !record.before ||
    !record.after ||
    record.createInput?.base?.sourceRef !== sourceRef ||
    kernel.filesystem.stat("/workspace/out.bin").ino !== kernel.inode ||
    !sameBytes(
      kernel.ports.inspectTree(record.after)?.["/out.bin"]?.data ?? new Uint8Array(),
      RESULT_FILE,
    )
  )
    throw new Error("The durable apply cut has no complete ownership receipt");
  return Object.freeze({
    operationId: ownership.commandOperation,
    before: Object.freeze({ ...record.before }),
    after: Object.freeze({ ...record.after }),
    inode: kernel.inode,
    sourceRef,
  });
}

/** Rebuilds every owner-local port from the same SQLite. It has no command execution path. */
export async function recoverComputerBoxdProof(input: {
  readonly ownership: ProofOwnership;
  readonly endpoint: string;
  readonly signal: AbortSignal;
  readonly expected: ProofRecoveryReceipt;
}) {
  const { ownership, expected, signal } = input;
  signal.throwIfAborted();
  const record = ownership.journal.read(expected.operationId);
  if (
    expected.operationId !== ownership.commandOperation ||
    record?.phase !== "apply" ||
    !record.machine ||
    !sameRevision(record.before, expected.before) ||
    !sameRevision(record.after, expected.after) ||
    expected.before.commit === expected.after.commit ||
    record.createInput?.operationId !== ownership.commandOperation ||
    record.createInput.drive !== ownership.drive ||
    record.createInput.recipeHash !== ownership.recipeHash ||
    record.createInput.base?.sourceRef !== expected.sourceRef
  )
    throw new Error("Recovery cut does not identify this durable command owner");

  const state = openProofFilesystem(ownership.storage);
  const { filesystem, persistence, ports } = state;
  let held: number | undefined;
  try {
    const before = ports.inspectTree(expected.before)?.["/out.bin"];
    const after = ports.inspectTree(expected.after)?.["/out.bin"];
    if (
      !before ||
      before.inode !== expected.inode ||
      after?.inode !== expected.inode ||
      !sameBytes(before.data, NESTED_PRIOR_FILE) ||
      !sameBytes(after.data, RESULT_FILE) ||
      filesystem.stat("/workspace/out.bin").ino !== expected.inode
    )
      throw new Error("The persisted revision bracket or kernel inode changed across replacement");
    held = filesystem.open(
      "/workspace/out.bin",
      KernelOpenFlags.O_RDONLY | KernelOpenFlags.O_CLOEXEC,
    );
    if (!sameBytes(state.read(held), NESTED_PRIOR_FILE))
      throw new Error("The fresh owner did not reopen the pre-apply kernel bytes");

    const provider = proofProvider(ownership.client, ownership.owner);
    const leases = createDurableProofBases(ownership.storage, {
      sourceRef: expected.sourceRef,
      drive: ownership.drive,
      recipeHash: ownership.recipeHash,
      verifyHeldSource: () => ownership.verifySource(expected.sourceRef),
      now: () => Date.now(),
      nextLeaseId: () => {
        throw new Error("Recovery cannot acquire another Base lease");
      },
    });
    const heldLeases = leases.inspect();
    if (heldLeases.acquired !== 1 || heldLeases.released !== 0 || heldLeases.held !== 1)
      throw new Error("The replacement did not retain the original Base lease");
    await ownership.check("replacementReopenedDurableBracket", "passed");
    const sockets = new RunnerMachineSockets({
      endpoint: input.endpoint,
      threadId: ThreadId.make(ownership.owner),
      workspaceReceipt: WORKSPACE_RECEIPT,
      cgroupPath: provider.cgroupPath,
      launch: async () => {
        throw new Error("Recovery cannot launch another Runner");
      },
      quiesce: (owner, closeSignal) => provider.quiesce(owner, closeSignal),
    });
    const workspace = createFacetWorkspace({
      database: ownership.storage,
      persistence,
      filesystem,
      mountPath: "/workspace",
      initial: PROOF_INITIAL_REVISION,
      mount: async () => {
        throw new Error("Recovery cannot prepare another workspace");
      },
      resume: createBoxdProofWorkspaceResume({
        vm: provider.vm,
        trackedFiles: [
          {
            path: "/out.bin",
            inode: expected.inode,
            stat: before.stat,
            posix: before.posix ?? null,
          },
        ],
        hydration: ports.hydration,
      }),
    });
    const runtime = createRunnerMachineRuntime(sockets);
    const machine = new MachineCommands({
      drive: ownership.drive,
      recipeHash: ownership.recipeHash,
      bases: {
        acquire: async () => {
          throw new Error("Recovery cannot acquire a Base");
        },
        release: (lease) => Effect.runPromise(leases.bases.release(lease)),
      },
      machines: {
        create: async () => {
          throw new Error("Recovery cannot create a machine");
        },
        reconcile: (createInput, reconcileSignal) =>
          ownership.commands.reconcile(createInput, reconcileSignal),
      },
      workspace,
      runtime: {
        attach: async () => {
          throw new Error("Recovery cannot attach a command runtime");
        },
        rebind: (owner) => {
          if (!runtime.rebind) throw new Error("Recovery runtime cannot attest ownership");
          return runtime.rebind(owner);
        },
      },
      ports: {
        hydration: ports.hydration,
        commits: {
          commit: async () => {
            throw new Error("Apply recovery cannot recommit the command");
          },
        },
      },
      journal: ownership.journal,
      nextOperationId: () => {
        throw new Error("Recovery cannot allocate a command identity");
      },
      coldExpiresAt: () => {
        throw new Error("Recovery cannot allocate a cold machine");
      },
      recoverySignal: signal,
    });
    await machine.recoverPending();
    const settled = ownership.journal.read(expected.operationId);
    const counts = leases.inspect();
    if (
      settled?.phase !== "complete" ||
      !sameRevision(settled.before, expected.before) ||
      !sameRevision(settled.after, expected.after) ||
      counts.acquired !== 1 ||
      counts.released !== 1 ||
      counts.held !== 0 ||
      filesystem.fstat(held).ino !== expected.inode ||
      filesystem.stat("/workspace/out.bin").ino !== expected.inode ||
      !sameBytes(state.read(held), RESULT_FILE) ||
      !sameBytes(
        ports.inspectTree(expected.before)?.["/out.bin"]?.data ?? new Uint8Array(),
        NESTED_PRIOR_FILE,
      ) ||
      !sameBytes(
        ports.inspectTree(expected.after)?.["/out.bin"]?.data ?? new Uint8Array(),
        RESULT_FILE,
      )
    )
      throw new Error(
        "Replacement recovery did not settle the original inode and revision bracket",
      );
    const absence = await ownership.commands.reconcile(
      {
        ...record.createInput,
        drive: ownership.drive,
        recipeHash: ownership.recipeHash,
        base: Option.some(record.createInput.base),
      },
      signal,
    );
    if (absence.status !== "absent")
      throw new Error("The command machine is still present after replacement recovery");
    await absence.releaseReservation();
    for (const check of [
      "replacementBeforeImmutable",
      "replacementAfterCommitStable",
      "replacementOriginalInodeApplied",
      "replacementResultBytesMatch",
      "replacementNoReplay",
      "replacementBaseLeaseReleased",
      "replacementMachineAbsent",
      "replacementJournalComplete",
    ])
      await ownership.check(check, "passed");
    // The old root died at the cut. A separate normal nested run proves its returned streams.
    for (const check of [
      "commandResult",
      "nativeCommandBytesAndExit",
      "commandStdoutBytesMatch",
      "commandStderrBytesMatch",
      "commandExitCode17",
      "commandSignalZero",
      "commandCoreDumpedFalse",
      "heldInodeRevisionAssertion",
      "sameOpenInodeApplied",
      "nestedPriorWriteAndRootContinuation",
    ])
      await ownership.check(check, "skipped");
  } finally {
    if (held !== undefined) filesystem.close(held);
    state.close();
  }
}
