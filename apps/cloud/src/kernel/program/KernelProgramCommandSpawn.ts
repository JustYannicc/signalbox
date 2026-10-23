import {
  kernelError,
  kernelOk,
  type KernelHandle,
  type KernelResult,
  type ResolvedProgram,
} from "../KernelAbi.ts";
import type { KernelCommand } from "../KernelCommandForwarder.ts";
import type {
  KernelProgramAdmissionDecision,
  KernelProgramAdmissionRequest,
} from "../KernelProgramAdmission.ts";
import type { KernelProcessTable } from "../KernelProcessTable.ts";
import type { KernelWakeRegistry } from "../KernelWakeRegistry.ts";
import type {
  KernelPreparedProgram,
  KernelProgramPrepareInput,
  KernelProgramPrepareOptions,
} from "./KernelPreparedProgram.ts";
import { KernelProgramAdmissionTicket } from "./KernelProgramAdmissionTicket.ts";
import {
  resolveKernelProgramFileBytes,
  type KernelProgramFileByteSelector,
} from "./KernelProgramFileBytes.ts";
import { preparePipedKernelProgram, type KernelPipedProgram } from "./KernelProgramPipes.ts";
import type { KernelProgramBinding, KernelProgramImplementation } from "./KernelProgramRuntime.ts";

interface CommandSpawnOptions {
  readonly processes: KernelProcessTable;
  readonly wakes: KernelWakeRegistry;
  readonly resolve: (executable: string) => KernelResult<ResolvedProgram>;
  readonly bindingFor: (program: ResolvedProgram) => KernelProgramBinding | undefined;
  readonly selectFileBytes?: KernelProgramFileByteSelector;
  readonly admit?: (
    request: KernelProgramAdmissionRequest,
  ) => Promise<KernelProgramAdmissionDecision>;
  readonly launch: (
    prepared: KernelPreparedProgram,
    implementation: KernelProgramImplementation,
    command: KernelCommand,
    ticket: KernelProgramAdmissionTicket | undefined,
  ) => KernelResult<KernelHandle<"process">>;
}

/** Root commands capture authority before allocating their replacement standard descriptors. */
export async function spawnKernelCommandPiped(
  input: KernelProgramPrepareInput,
  command: KernelCommand,
  prepareOptions: Pick<KernelProgramPrepareOptions, "fileBytes">,
  options: CommandSpawnOptions,
): Promise<
  KernelResult<{ readonly handle: KernelHandle<"process">; readonly piped: KernelPipedProgram }>
> {
  const captured = Object.freeze({
    executable: command.executable,
    argv: Object.freeze([...command.argv]),
    env: Object.freeze({ ...command.env }),
    cwd: command.cwd,
  });
  const capturedInput = Object.freeze({
    filesystem: input.filesystem,
    signal: input.signal ?? new AbortController().signal,
    ...(input.parent === undefined
      ? {}
      : { parent: Object.freeze({ id: input.parent.id, kind: input.parent.kind }) }),
    ...(input.home === undefined ? {} : { home: input.home }),
  });
  const baseCwd = capturedInput.filesystem.cwd;
  if (capturedInput.signal.aborted) return kernelError("CANCELLED", "Command launch cancelled");
  const resolved = options.resolve(captured.executable);
  if (resolved.status === "would_block") return resolved;
  let target: KernelProgramAdmissionRequest["target"];
  if (resolved.status === "ok") {
    const binding = options.bindingFor(resolved.value);
    if (binding === undefined) {
      return kernelError("INVALID_ARGUMENT", "Resolved executable lost its mapping");
    }
    target = Object.freeze({ kind: "resolved", program: resolved.value, binding });
  } else if (
    options.admit !== undefined &&
    (resolved.error.code === "NOT_FOUND" || resolved.error.code === "UNSUPPORTED")
  ) {
    target = Object.freeze({
      kind: "unsupported",
      code: resolved.error.code,
      message: resolved.error.message,
    });
  } else {
    return resolved;
  }
  const request: KernelProgramAdmissionRequest = Object.freeze({
    kind: "command",
    stdio: "piped",
    command: captured,
    baseCwd,
    actions: Object.freeze([]),
    attributes: undefined,
    processes: options.processes,
    ...capturedInput,
    target,
  });
  // A trusted selector chooses once; neither admission nor the command env can replace it.
  let fileBytes;
  try {
    fileBytes = resolveKernelProgramFileBytes({
      executable: captured.executable,
      ...(prepareOptions.fileBytes === undefined
        ? {}
        : { explicitSelection: prepareOptions.fileBytes }),
      ...(options.selectFileBytes === undefined ? {} : { selector: options.selectFileBytes }),
      filesystem: capturedInput.filesystem,
      ...(capturedInput.parent === undefined ? {} : { parent: capturedInput.parent }),
    });
    fileBytes = Object.freeze({ ...fileBytes });
  } catch (error) {
    return preparationError(error);
  }
  let ticket: KernelProgramAdmissionTicket | undefined;
  let piped: KernelPipedProgram | undefined;
  let accepted = false;
  try {
    let implementation: KernelProgramImplementation;
    let admission: object | undefined;
    if (options.admit !== undefined) {
      ticket = KernelProgramAdmissionTicket.from(request, await options.admit(request));
      const selection = ticket.resume();
      if (selection.kind === "unsupported") {
        return kernelError(selection.code, selection.message);
      }
      implementation = selection.implementation;
      admission = selection.admission;
    } else {
      if (target.kind === "unsupported") return kernelError(target.code, target.message);
      implementation = target.binding.implementation;
    }
    if (capturedInput.signal.aborted) return kernelError("CANCELLED", "Command launch cancelled");
    ticket?.assertCurrent();
    try {
      piped = preparePipedKernelProgram(
        options.wakes,
        { ...capturedInput, ...(admission === undefined ? {} : { admission }) },
        { cwd: captured.cwd, fileBytes, descriptorInheritance: "stdio" },
      );
    } catch (error) {
      return preparationError(error);
    }
    const spawned = options.launch(piped.prepared, implementation, captured, ticket);
    if (spawned.status !== "ok") return spawned;
    accepted = true;
    return kernelOk({ handle: spawned.value, piped });
  } finally {
    if (!accepted) {
      ticket?.cancel();
      try {
        try {
          await piped?.prepared.release();
        } finally {
          // Aborted streams can already be errored; their endpoints still need closing.
          await Promise.allSettled([
            piped?.stdout.cancel(),
            piped?.stderr.cancel(),
            piped?.stdin.abort(),
          ]);
        }
      } finally {
        ticket?.throwCancelFailure();
      }
    }
  }
}

function preparationError(error: unknown): KernelResult<never> {
  const unsupported =
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOTSUP";
  return kernelError(
    unsupported ? "UNSUPPORTED" : "IO_ERROR",
    error instanceof Error ? error.message : "Command preparation failed",
  );
}
