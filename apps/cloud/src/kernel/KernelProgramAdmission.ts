import type { KernelHandle, ResolvedProgram } from "./KernelAbi.ts";
import type {
  KernelAsyncProgram,
  KernelAsyncProgramContext,
  KernelAsyncProgramExecRequest,
} from "./KernelAsyncProgram.ts";
import type { AgentOsSpawnRequest } from "./AgentOsProcessWire.ts";
import type { KernelCommand } from "./KernelCommandForwarder.ts";
import type { KernelFileSystem } from "./KernelFileSystem.ts";
import type { KernelProcessIdentity, KernelProcessTable } from "./KernelProcessTable.ts";
import type { KernelProgramBinding } from "./program/KernelProgramRuntime.ts";

export interface KernelProgramAdmissionRequest {
  readonly kind: "spawn" | "exec";
  readonly command: KernelCommand;
  /** Filesystem cwd before this request's cwd or file actions are applied. */
  readonly baseCwd: string;
  readonly actions: AgentOsSpawnRequest["actions"];
  readonly attributes: AgentOsSpawnRequest["attributes"] | undefined;
  readonly filesystem: KernelFileSystem;
  readonly processes: KernelProcessTable;
  readonly signal: AbortSignal;
  readonly home?: string;
  readonly parent?: KernelHandle<"process">;
  readonly identity?: KernelProcessIdentity;
  readonly admission?: object;
  readonly target:
    | {
        readonly kind: "resolved";
        readonly program: ResolvedProgram;
        readonly binding: KernelProgramBinding;
      }
    | {
        readonly kind: "unsupported";
        readonly code: "NOT_FOUND" | "UNSUPPORTED";
        readonly message: string;
      };
}

export type KernelProgramAdmissionDecision =
  | {
      readonly kind: "local";
      readonly admission?: object;
      readonly cancel?: () => void;
      readonly assertCurrent?: () => void;
      readonly onDispatch?: (context: KernelAsyncProgramContext) => void;
    }
  | {
      readonly kind: "forward";
      readonly implementation: {
        readonly kind: "async";
        readonly run: KernelAsyncProgram["run"];
      };
      readonly admission?: object;
      readonly cancel?: () => void;
      readonly assertCurrent?: () => void;
      readonly onDispatch?: (context: KernelAsyncProgramContext) => void;
    };

export type KernelProgramSpawnAdmissionCapture = Omit<
  KernelProgramAdmissionRequest,
  "target" | "attributes" | "parent"
> & {
  readonly attributes: AgentOsSpawnRequest["attributes"];
  readonly parent: KernelHandle<"process">;
  readonly requestedCwd?: string;
  readonly pidPointer: number;
};

export function captureKernelProgramSpawnAdmission(input: {
  readonly filesystem: KernelFileSystem;
  readonly processes: KernelProcessTable;
  readonly parent: KernelHandle<"process">;
  readonly signal: AbortSignal;
  readonly home: string | undefined;
  readonly request: AgentOsSpawnRequest;
  readonly admission: object | undefined;
}): KernelProgramSpawnAdmissionCapture {
  const { filesystem, processes, parent, signal, home, request, admission } = input;
  const baseCwd = filesystem.cwd;
  const command = Object.freeze({
    executable: request.execPath,
    argv: Object.freeze([...request.argv]),
    cwd: request.cwd ?? baseCwd,
    env: Object.freeze({ ...request.env }),
  });
  const actions = Object.freeze(request.actions.map((action) => Object.freeze({ ...action })));
  const attributes = Object.freeze({
    flags: request.attributes.flags,
    defaultMask: Object.freeze({ ...request.attributes.defaultMask }),
    signalMask: Object.freeze({ ...request.attributes.signalMask }),
    processGroup: request.attributes.processGroup,
  });
  return Object.freeze({
    kind: "spawn",
    command,
    baseCwd,
    actions,
    attributes,
    filesystem,
    processes,
    signal,
    ...(home === undefined ? {} : { home }),
    parent: Object.freeze({ id: parent.id, kind: parent.kind }),
    ...(request.cwd === undefined ? {} : { requestedCwd: request.cwd }),
    ...(admission === undefined ? {} : { admission }),
    pidPointer: request.pidPointer,
  });
}

export function createKernelProgramSpawnAdmissionRequest(
  capture: KernelProgramSpawnAdmissionCapture,
  target: KernelProgramAdmissionRequest["target"],
): KernelProgramAdmissionRequest {
  return Object.freeze({
    kind: capture.kind,
    command: capture.command,
    baseCwd: capture.baseCwd,
    actions: capture.actions,
    attributes: capture.attributes,
    filesystem: capture.filesystem,
    processes: capture.processes,
    signal: capture.signal,
    ...(capture.home === undefined ? {} : { home: capture.home }),
    parent: capture.parent,
    ...(capture.admission === undefined ? {} : { admission: capture.admission }),
    target,
  });
}

export function captureKernelProgramExecAdmission(
  request: KernelAsyncProgramExecRequest,
  processes: KernelProcessTable,
): Omit<KernelProgramAdmissionRequest, "target"> {
  const baseCwd = request.filesystem.cwd;
  const command = Object.freeze({
    executable: request.path,
    argv: Object.freeze([...request.args]),
    cwd: baseCwd,
    env: Object.freeze({ ...request.env }),
  });
  return Object.freeze({
    kind: "exec",
    command,
    baseCwd,
    actions: Object.freeze([]),
    attributes: undefined,
    filesystem: request.filesystem,
    processes,
    signal: request.signal,
    ...(request.home === undefined ? {} : { home: request.home }),
    identity: Object.freeze({ handle: request.identity.handle, pid: request.identity.pid }),
    ...(request.admission === undefined ? {} : { admission: request.admission }),
  });
}

export function createKernelProgramExecAdmissionRequest(
  capture: Omit<KernelProgramAdmissionRequest, "target">,
  target: KernelProgramAdmissionRequest["target"],
): KernelProgramAdmissionRequest {
  return Object.freeze({ ...capture, target });
}
