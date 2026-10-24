import {
  makeThreadExecForwarder,
  type RunnerExecSocketHost,
  type ThreadExecLease,
} from "../thread/ThreadExecForwarder.ts";
import type { MachineHandle, MachineOwnershipAttestation } from "./Machine.ts";
import { RunnerMachineFileLookupForwarder } from "./MachineFileLookupForwarder.ts";
import type { MachineFileSourceAttestation } from "./MachineFilesPort.ts";
import type {
  MachineCommandRuntime,
  MachineProcessClosureAttestation,
} from "./MachineWorkspace.ts";

export interface MachineRunnerOwner {
  readonly operationId: string;
  readonly machine: MachineHandle;
}

export interface MachineRunnerConnection {
  readonly owner: MachineOwnershipAttestation;
  readonly lease: ThreadExecLease;
  readonly dispose: () => Promise<void>;
}

export interface MachineRunnerTransport {
  /** Install exec on the machine's accepted Runner socket, keeping generation fences intact. */
  readonly connect: (
    input: MachineRunnerOwner & {
      readonly socketHost: RunnerExecSocketHost;
      readonly signal: AbortSignal;
    },
  ) => Promise<MachineRunnerConnection>;
  /** Native ownership proof: returning means this operation cannot write to the workspace again. */
  readonly quiesce: (
    input: MachineRunnerOwner & { readonly signal: AbortSignal },
  ) => Promise<MachineProcessClosureAttestation>;
}

export interface RunnerMachineRuntimeOptions {
  /** Supplies lifecycle-owned state that remains authoritative across Computer reopen. */
  readonly machineFileSource?: (
    owner: MachineRunnerOwner,
  ) => MachineFileSourceAttestation | undefined;
  readonly machineFileLookupTimeoutMs?: number;
}

/** Keeps the proven non-PTY transport while requiring provider authority for process closure. */
export function createRunnerMachineRuntime(
  transport: MachineRunnerTransport,
  options: RunnerMachineRuntimeOptions = {},
): MachineCommandRuntime {
  return {
    async attach(input) {
      input.signal.throwIfAborted();
      const owner = ownership(input);
      let connection: MachineRunnerConnection | undefined;
      let admissionClosed = false;
      let spawnStarted = false;
      const acquireLease: ThreadExecLease["acquire"] = async (signal) => {
        if (admissionClosed || connection === undefined) {
          throw new Error("Machine Runner admission is closed");
        }
        const lease = await connection.lease.acquire(signal);
        if (admissionClosed || lease.generation !== owner.generation) {
          await lease.release();
          throw new Error("Machine Runner lease belongs to another generation");
        }
        return lease;
      };
      const machineFileSource = options.machineFileSource?.(input);
      const machineFiles = new RunnerMachineFileLookupForwarder({
        ...(machineFileSource === undefined ? {} : { source: machineFileSource }),
        ...(options.machineFileLookupTimeoutMs === undefined
          ? {}
          : { timeoutMs: options.machineFileLookupTimeoutMs }),
      });
      const forwarder = makeThreadExecForwarder({
        workspace: input.workspace,
        policy: input.policy,
        beforeStart: async (generation, _command, signal) => {
          signal.throwIfAborted();
          if (generation !== owner.generation) {
            throw new Error("Machine Runner command belongs to another generation");
          }
          await machineFiles.markExecuted(generation);
          signal.throwIfAborted();
        },
        lease: { acquire: acquireLease },
      });
      try {
        connection = await transport.connect({
          ...input,
          socketHost: {
            connected(socket, candidate) {
              if (candidate.generation !== owner.generation)
                throw new Error("Unexpected Runner generation");
              const wrapped: typeof candidate = {
                ...candidate,
                send(message) {
                  if (
                    admissionClosed &&
                    (message.type === "machine.files.request" ||
                      (message.type === "exec.command" && message.command.type === "start"))
                  ) {
                    throw new Error("Machine Runner admission is closed");
                  }
                  candidate.send(message);
                },
              };
              forwarder.socketHost.connected(socket, wrapped);
              machineFiles.socketHost.connected(socket, wrapped);
            },
            report: forwarder.socketHost.report,
            machineFileResult: machineFiles.socketHost.result,
            disconnected(socket, generation, candidateConnection) {
              forwarder.socketHost.disconnected(socket, generation, candidateConnection);
              machineFiles.socketHost.disconnected(socket, generation, candidateConnection);
            },
            generationEnded(generation) {
              forwarder.socketHost.generationEnded(generation);
              machineFiles.socketHost.generationEnded(generation);
            },
          },
        });
        assertOwner(owner, connection.owner);
      } catch (error) {
        admissionClosed = true;
        await machineFiles.dispose();
        await forwarder.dispose();
        await connection?.dispose();
        throw error;
      }
      const connected = connection;
      let closure: MachineProcessClosureAttestation | undefined;
      let closing: Promise<MachineProcessClosureAttestation> | undefined;
      return {
        owner,
        machineFiles,
        spawn: (command, signal) => {
          if (admissionClosed || spawnStarted)
            return Promise.reject(new Error("Machine Runner admission is closed"));
          spawnStarted = true;
          return forwarder.spawn(command, signal);
        },
        quiesce(signal) {
          admissionClosed = true;
          closing ??= (async () => {
            await machineFiles.dispose();
            closure ??= await transport.quiesce({
              operationId: input.operationId,
              machine: input.machine,
              signal,
            });
            assertClosure(owner, closure);
            // Only the provider's closure attestation can end uncertain Runner ownership.
            forwarder.socketHost.generationEnded(owner.generation);
            await forwarder.dispose();
            return closure;
          })().catch((error: unknown) => {
            closing = undefined;
            closure = undefined;
            throw error;
          });
          return closing;
        },
        async dispose() {
          admissionClosed = true;
          await machineFiles.dispose();
          await forwarder.dispose();
          await connected.dispose();
        },
      };
    },
    async rebind(input) {
      input.signal.throwIfAborted();
      const owner = ownership(input);
      let closure: MachineProcessClosureAttestation | undefined;
      return {
        owner,
        async quiesce(signal) {
          if (closure === undefined) {
            const result = await transport.quiesce({ ...input, signal });
            assertClosure(owner, result);
            closure = Object.freeze({ ...owner, closed: true });
          }
          return closure;
        },
        async dispose() {
          if (closure === undefined) throw new Error("Recovered machine closure is unverified");
          assertClosure(owner, closure);
        },
      };
    },
  };
}

function ownership(input: MachineRunnerOwner): MachineOwnershipAttestation {
  if (
    !input.operationId ||
    !input.machine.id ||
    !Number.isSafeInteger(input.machine.generation) ||
    input.machine.generation < 1
  ) {
    throw new Error("Invalid machine Runner ownership");
  }
  return Object.freeze({
    operationId: input.operationId,
    machineId: input.machine.id,
    generation: input.machine.generation,
  });
}

function assertOwner(expected: MachineOwnershipAttestation, actual: MachineOwnershipAttestation) {
  if (
    actual.operationId !== expected.operationId ||
    actual.machineId !== expected.machineId ||
    actual.generation !== expected.generation
  ) {
    throw new Error("Machine Runner ownership does not match this operation");
  }
}

function assertClosure(
  owner: MachineOwnershipAttestation,
  closure: MachineProcessClosureAttestation,
) {
  assertOwner(owner, closure);
  if (closure.closed !== true) throw new Error("Machine Runner processes are not closed");
}
