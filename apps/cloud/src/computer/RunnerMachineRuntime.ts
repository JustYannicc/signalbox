import {
  makeThreadExecForwarder,
  type RunnerExecSocketHost,
  type ThreadExecLease,
} from "../thread/ThreadExecForwarder.ts";
import type { MachineHandle, MachineOwnershipAttestation } from "./Machine.ts";
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

/** Keeps the proven non-PTY transport while requiring provider authority for process closure. */
export function createRunnerMachineRuntime(
  transport: MachineRunnerTransport,
): MachineCommandRuntime {
  return {
    async attach(input) {
      input.signal.throwIfAborted();
      const owner = ownership(input);
      let connection: MachineRunnerConnection | undefined;
      let admissionClosed = false;
      let spawnStarted = false;
      const forwarder = makeThreadExecForwarder({
        workspace: input.workspace,
        policy: input.policy,
        lease: {
          async acquire(signal) {
            if (admissionClosed || connection === undefined) {
              throw new Error("Machine Runner admission is closed");
            }
            const lease = await connection.lease.acquire(signal);
            if (admissionClosed || lease.generation !== owner.generation) {
              await lease.release();
              throw new Error("Machine Runner lease belongs to another generation");
            }
            return lease;
          },
        },
      });
      try {
        connection = await transport.connect({
          ...input,
          socketHost: {
            ...forwarder.socketHost,
            connected(socket, candidate) {
              if (candidate.generation !== owner.generation)
                throw new Error("Unexpected Runner generation");
              forwarder.socketHost.connected(socket, {
                ...candidate,
                send(message) {
                  if (admissionClosed && message.command.type === "start") {
                    throw new Error("Machine Runner admission is closed");
                  }
                  candidate.send(message);
                },
              });
            },
          },
        });
        assertOwner(owner, connection.owner);
      } catch (error) {
        admissionClosed = true;
        await forwarder.dispose();
        await connection?.dispose();
        throw error;
      }
      const connected = connection;
      let closure: MachineProcessClosureAttestation | undefined;
      let closing: Promise<MachineProcessClosureAttestation> | undefined;
      return {
        owner,
        spawn: (command, signal) => {
          if (admissionClosed || spawnStarted)
            return Promise.reject(new Error("Machine Runner admission is closed"));
          spawnStarted = true;
          return forwarder.spawn(command, signal);
        },
        quiesce(signal) {
          admissionClosed = true;
          closing ??= (async () => {
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
