// @effect-diagnostics globalDate:off - the disposable proof sets explicit provider expiry deadlines.
import * as Effect from "effect/Effect";
import { ThreadId } from "@t3tools/contracts";
import { createComputerCommands } from "../../src/computer/ComputerCommands.ts";
import { ComputerEscalationTable } from "../../src/computer/EscalationTable.ts";
import { MachineCommands } from "../../src/computer/MachineCommands.ts";
import { createRunnerMachineRuntime } from "../../src/computer/RunnerMachineRuntime.ts";
import {
  RunnerMachineSockets,
  type RunnerMachineSocketsOptions,
} from "../../src/computer/RunnerMachineSockets.ts";
import { createDurableProofBases } from "./DurableBases.ts";
import { proofKernel } from "./Kernel.ts";
import { ProofOwnership } from "./Ownership.ts";
import { proofProvider, WORKSPACE_RECEIPT } from "./Provider.ts";
import { runProofCommandStage } from "./SourcePreparation.ts";
import type {
  ProofCommandReporter,
  ProofCommandStage,
  SourcePreparationDiagnostic,
  SourcePreparationStep,
} from "./SourcePreparation.ts";
import { PROOF_COMMAND, runProofCommand } from "./Command.ts";
import type { ProofCommandResultDiagnostics } from "./Command.ts";
import type { decodeProofSeed } from "./SeedProtocol.ts";
import {
  captureNestedForwarding,
  NESTED_PRIOR_FILE,
  NESTED_PROOF_COMMAND,
} from "./NestedCommand.ts";
import type { ProofRecoveryReceipt } from "./OwnerReplacement.ts";
import { proofRecoveryReceipt } from "./Recovery.ts";
import { createProofChildLoader } from "./ChildLoader.ts";

const SOURCE_PHASE_CHECKS = {
  directoriesExec: "sourceDirectoriesExec",
  runnerUpload: "sourceRunnerUpload",
  installExec: "sourceArtifactInstallExec",
} satisfies Record<SourcePreparationStep, string>;
const COMMAND_PHASE_CHECKS = {
  workspacePrepare: "commandWorkspacePrepare",
  runtimeConnect: "commandRuntimeConnect",
  inheritedSourceCheck: "runnerInheritedSourceCheck",
  runnerConfigUpload: "runnerConfigUpload",
  runnerReceiptUpload: "runnerReceiptUpload",
  runnerBootstrapInstall: "runnerBootstrapInstall",
  runnerLaunchFence: "runnerLaunchFence",
  workspaceNativePrepare: "workspaceNativePrepare",
  workspaceNativeFinalize: "workspaceNativeFinalize",
  workspaceNativeScan: "workspaceNativeScan",
  workspaceNativeCwd: "workspaceNativeCwd",
  workspaceNativeFileUpload: "workspaceNativeFileUpload",
} satisfies Record<ProofCommandStage, string>;
const COMMAND_RESULT_CHECKS = [
  ["stdoutBytesMatch", "commandStdoutBytesMatch"],
  ["stderrBytesMatch", "commandStderrBytesMatch"],
  ["exitCode17", "commandExitCode17"],
  ["signalZero", "commandSignalZero"],
  ["coreDumpedFalse", "commandCoreDumpedFalse"],
] as const satisfies readonly (readonly [keyof ProofCommandResultDiagnostics, string])[];
const SAFE_CHECK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

function sourceDiagnosticCheckName(
  step: SourcePreparationStep,
  diagnostic: SourcePreparationDiagnostic,
) {
  const name = `src_${step}_${diagnostic.kind}_${diagnostic.value}`;
  if (!SAFE_CHECK_NAME.test(name)) throw new Error("Invalid source diagnostic check name");
  return name;
}

function commandDiagnosticCheckName(
  step: ProofCommandStage,
  diagnostic: SourcePreparationDiagnostic,
) {
  const name = `cmd_${step}_${diagnostic.kind}_${diagnostic.value}`;
  if (!SAFE_CHECK_NAME.test(name)) throw new Error("Invalid command diagnostic check name");
  return name;
}

export async function runComputerBoxdProof(input: {
  readonly ctx: RunnerMachineSocketsOptions["ctx"];
  readonly ownership: ProofOwnership;
  readonly seed: Awaited<ReturnType<typeof decodeProofSeed>>;
  readonly loader: WorkerLoader;
  readonly endpoint: string;
  readonly signal: AbortSignal;
  readonly publishSockets: (sockets: RunnerMachineSockets) => void;
  readonly mode?: "direct" | "nested";
  readonly onBeforeApply?: (receipt: ProofRecoveryReceipt) => Promise<void>;
}) {
  const { ownership, seed, signal } = input;
  await ownership.check("kernelSetup", "pending");
  const loader = createProofChildLoader(input.loader);
  const kernel = proofKernel(ownership.storage, loader, seed);
  const commandReporter: ProofCommandReporter = async (step, outcome, diagnostics) => {
    await ownership.check(COMMAND_PHASE_CHECKS[step], outcome);
    for (const diagnostic of diagnostics ?? []) {
      await ownership.check(commandDiagnosticCheckName(step, diagnostic), "failed");
    }
  };
  const provider = proofProvider(ownership.client, ownership.owner, commandReporter);
  try {
    await ownership.check("kernelSetup", "passed");
    await ownership.check("childDynamicWorkerControl", "pending");
    const localChecks = await kernel.localControl(signal);
    for (const [name, passed] of Object.entries(localChecks)) {
      await ownership.check(name, passed ? "passed" : "failed");
      if (!passed) throw new Error("Local-only admitted control failed");
    }
    await ownership.check("childDynamicWorkerControl", "passed");
    signal.throwIfAborted();
    await ownership.check("warmSourcePrepared", "pending");
    const sourceInput = await ownership.prepareSourceInput();
    await ownership.check("sourceAllocated", "pending");
    let source: Awaited<ReturnType<typeof ownership.source.create>>;
    try {
      source = await ownership.source.create(sourceInput, signal);
    } catch (error) {
      try {
        await ownership.check("sourceAllocated", "failed");
      } catch {
        // Keep the source creation rejection as the failure reported to the worker.
      }
      throw error;
    }
    await ownership.check("sourceAllocated", "passed");
    await ownership.check("sourceRetention", "pending");
    try {
      await ownership.verifySource(source.id);
    } catch (error) {
      try {
        await ownership.check("sourceRetention", "failed");
      } catch {
        // Keep the retention readback rejection as the failure reported to the worker.
      }
      throw error;
    }
    await ownership.check("sourceRetention", "passed");
    await provider.prepareSource(
      source.id,
      seed.runner.bytes,
      signal,
      async (step, outcome, diagnostics) => {
        await ownership.check(SOURCE_PHASE_CHECKS[step], outcome);
        for (const diagnostic of diagnostics ?? []) {
          await ownership.check(sourceDiagnosticCheckName(step, diagnostic), "failed");
        }
      },
    );
    await ownership.check("warmSourcePrepared", "passed");

    const leases = createDurableProofBases(ownership.storage, {
      sourceRef: source.id,
      drive: ownership.drive,
      recipeHash: ownership.recipeHash,
      verifyHeldSource: () => ownership.verifySource(source.id),
      now: () => Date.now(),
      nextLeaseId: () => `${ownership.owner}-lease-1`,
    });
    const sockets = new RunnerMachineSockets({
      ctx: input.ctx,
      endpoint: input.endpoint,
      threadId: ThreadId.make(ownership.owner),
      workspaceReceipt: WORKSPACE_RECEIPT,
      cgroupPath: provider.cgroupPath,
      launch: (config, launchSignal) => provider.launch(config, launchSignal),
      quiesce: async (owner, closeSignal) => {
        const result = await provider.quiesce(owner, closeSignal);
        await ownership.check("nativeLaunchFenceAndClosure", "passed");
        return result;
      },
    });
    input.publishSockets(sockets);
    const workspacePort = kernel.workspace(provider.vm);
    const workspace = {
      ...workspacePort,
      apply: async (...args: Parameters<typeof workspacePort.apply>) => {
        if (input.onBeforeApply) {
          await reportNestedCapture();
          await input.onBeforeApply(proofRecoveryReceipt(ownership, source.id, kernel));
        }
        return workspacePort.apply(...args);
      },
      prepare: (...args: Parameters<typeof workspacePort.prepare>) =>
        runProofCommandStage(commandReporter, "workspacePrepare", () =>
          workspacePort.prepare(...args),
        ),
    };
    const runtimePort = createRunnerMachineRuntime(sockets);
    const runtime = {
      ...runtimePort,
      attach: (...args: Parameters<typeof runtimePort.attach>) =>
        runProofCommandStage(commandReporter, "runtimeConnect", () => runtimePort.attach(...args)),
    };
    const machine = new MachineCommands({
      drive: ownership.drive,
      recipeHash: ownership.recipeHash,
      bases: {
        acquire: () =>
          Effect.runPromise(leases.bases.acquire(ownership.drive, ownership.recipeHash)),
        release: (lease) => Effect.runPromise(leases.bases.release(lease)),
      },
      machines: ownership.commands,
      workspace,
      runtime,
      ports: kernel.ports,
      journal: ownership.journal,
      nextOperationId: () => ownership.commandOperation,
      coldExpiresAt: () => Date.now() + 600_000,
      recoverySignal: new AbortController().signal,
    });
    await machine.recoverPending();
    const nested = input.mode === "nested" ? captureNestedForwarding(machine) : undefined;
    const reportNestedCapture = async () => {
      if (!nested) return;
      for (const [name, passed] of Object.entries({
        ...nested.diagnostics(),
        ...kernel.admissionDiagnostics(),
      })) {
        await ownership.check(name, passed ? "passed" : "failed");
        if (!passed) throw new Error("Nested command admission changed its raw command");
      }
    };
    if (nested) kernel.bindNestedMachine(nested.machine);
    const commands = nested
      ? kernel.commands
      : createComputerCommands({
          kernel: { host: kernel.host, filesystem: kernel.filesystem },
          escalation: new ComputerEscalationTable([
            { id: "proof-force-bash", executable: "/bin/bash" },
          ]),
          machine,
        });
    await ownership.check("nativeCommandBytesAndExit", "pending");
    await ownership.check("commandResult", "pending");
    try {
      await runProofCommand(
        await commands.exec(nested ? NESTED_PROOF_COMMAND : PROOF_COMMAND, signal),
        async (diagnostics) => {
          for (const [field, name] of COMMAND_RESULT_CHECKS) {
            await ownership.check(name, diagnostics[field] ? "passed" : "failed");
          }
        },
      );
    } catch (error) {
      try {
        await ownership.check("commandResult", "failed");
      } catch {
        // Keep the command result rejection as the failure reported to the worker.
      }
      throw error;
    }
    await ownership.check("commandResult", "passed");
    if (nested) {
      await reportNestedCapture();
      for (const [name, passed] of Object.entries(await kernel.settledDiagnostics())) {
        await ownership.check(name, passed ? "passed" : "failed");
        if (!passed) throw new Error("Admitted child capacity did not drain");
      }
      await ownership.check("nestedPriorWriteAndRootContinuation", "passed");
    }
    await ownership.check("leaseJournalSettlement", "pending");
    try {
      await machine.recoverPending();
    } catch (error) {
      try {
        await ownership.check("leaseJournalSettlement", "failed");
      } catch {
        // Keep the journal recovery rejection as the failure reported to the worker.
      }
      throw error;
    }
    await ownership.check("heldInodeRevisionAssertion", "pending");
    try {
      kernel.assertApplied(
        ownership.journal.read(ownership.commandOperation)?.before,
        nested ? NESTED_PRIOR_FILE : undefined,
      );
    } catch (error) {
      try {
        await ownership.check("heldInodeRevisionAssertion", "failed");
      } catch {
        // Keep the revision assertion rejection as the failure reported to the worker.
      }
      throw error;
    }
    await ownership.check("heldInodeRevisionAssertion", "passed");
    try {
      const counts = leases.inspect();
      const record = ownership.journal.read(ownership.commandOperation);
      if (
        counts.acquired !== 1 ||
        counts.released !== 1 ||
        counts.held !== 0 ||
        record?.phase !== "complete" ||
        !record.before ||
        !record.after ||
        record.before.commit === record.after.commit ||
        record.createInput?.base?.sourceRef !== source.id
      ) {
        throw new Error("Warm Base lease or command revision settlement is incomplete");
      }
    } catch (error) {
      try {
        await ownership.check("leaseJournalSettlement", "failed");
      } catch {
        // Keep the settlement assertion rejection as the failure reported to the worker.
      }
      throw error;
    }
    await ownership.check("warmForkInheritedSource", "passed");
    await ownership.check("sameOpenInodeApplied", "passed");
    await ownership.check("immutableRevisionBracket", "passed");
    await ownership.check("baseLeaseReleased", "passed");
    await ownership.check("leaseJournalSettlement", "passed");
    await ownership.check("nativeCommandBytesAndExit", "passed");
  } finally {
    await kernel.close();
  }
}
