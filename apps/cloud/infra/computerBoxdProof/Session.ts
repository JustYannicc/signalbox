// @effect-diagnostics globalDate:off - the disposable proof sets explicit provider expiry deadlines.
import * as Effect from "effect/Effect";
import { ThreadId } from "@t3tools/contracts";
import { createComputerCommands } from "../../src/computer/ComputerCommands.ts";
import { ComputerEscalationTable } from "../../src/computer/EscalationTable.ts";
import { MachineCommands } from "../../src/computer/MachineCommands.ts";
import { createRunnerMachineRuntime } from "../../src/computer/RunnerMachineRuntime.ts";
import { RunnerMachineSockets } from "../../src/computer/RunnerMachineSockets.ts";
import { createProofBases } from "./Bases.ts";
import { proofKernel } from "./Kernel.ts";
import { ProofOwnership } from "./Ownership.ts";
import { proofProvider, WORKSPACE_RECEIPT } from "./Provider.ts";
import { PROOF_COMMAND, runProofCommand } from "./Command.ts";
import type { decodeProofSeed } from "./SeedProtocol.ts";

export async function runComputerBoxdProof(input: {
  readonly ownership: ProofOwnership;
  readonly seed: Awaited<ReturnType<typeof decodeProofSeed>>;
  readonly loader: WorkerLoader;
  readonly endpoint: string;
  readonly signal: AbortSignal;
  readonly publishSockets: (sockets: RunnerMachineSockets) => void;
}) {
  const { ownership, seed, signal } = input;
  const kernel = proofKernel(ownership.storage, input.loader, seed);
  const provider = proofProvider(ownership.client, ownership.owner);
  try {
    await ownership.check("childDynamicWorkerControl", "pending");
    await kernel.localControl(signal);
    await ownership.check("childDynamicWorkerControl", "passed");
    signal.throwIfAborted();
    await ownership.check("warmSourcePrepared", "pending");
    const sourceInput = await ownership.prepareSourceInput();
    const source = await ownership.source.create(sourceInput, signal);
    await ownership.verifySource(source.id);
    await provider.prepareSource(source.id, seed.runner.bytes, signal);
    await ownership.check("warmSourcePrepared", "passed");

    const leases = createProofBases({
      sourceRef: source.id,
      drive: ownership.drive,
      recipeHash: ownership.recipeHash,
      verifyHeldSource: () => ownership.verifySource(source.id),
      now: () => Date.now(),
      nextLeaseId: () => `${ownership.owner}-lease-1`,
    });
    const sockets = new RunnerMachineSockets({
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
    const workspace = kernel.workspace(provider.vm);
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
      runtime: createRunnerMachineRuntime(sockets),
      ports: kernel.ports,
      journal: ownership.journal,
      nextOperationId: () => ownership.commandOperation,
      coldExpiresAt: () => Date.now() + 600_000,
      recoverySignal: new AbortController().signal,
    });
    await machine.recoverPending();
    const commands = createComputerCommands({
      kernel: { host: kernel.host, filesystem: kernel.filesystem },
      escalation: new ComputerEscalationTable([
        { id: "proof-force-bash", executable: "/bin/bash" },
      ]),
      machine,
    });
    await ownership.check("nativeCommandBytesAndExit", "pending");
    await runProofCommand(await commands.exec(PROOF_COMMAND, signal));
    await machine.recoverPending();
    kernel.assertApplied();
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
    await ownership.check("warmForkInheritedSource", "passed");
    await ownership.check("nativeCommandBytesAndExit", "passed");
    await ownership.check("sameOpenInodeApplied", "passed");
    await ownership.check("immutableRevisionBracket", "passed");
    await ownership.check("baseLeaseReleased", "passed");
  } finally {
    await kernel.close();
  }
}
