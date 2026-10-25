// @effect-diagnostics nodeBuiltinImport:off - node:os supplies static signal names; delivery stays with KernelProcessTable.
import * as NodeOS from "node:os";

import { type KernelErrorCode, type KernelResult } from "../../../kernel/KernelAbi.ts";
import { NodeSystemError } from "./NodeError.ts";

const signalNumbers = NodeOS.constants.signals as Readonly<Record<string, number>>;

export function normalizeNodeSignal(signal: string | number | undefined): number {
  if (signal === undefined) return signalNumbers.SIGTERM ?? 15;
  if (typeof signal === "number") return signal;
  const number = Object.hasOwn(signalNumbers, signal) ? signalNumbers[signal] : undefined;
  if (number !== undefined) return number;
  throw new NodeSystemError("EINVAL", `Unknown signal: ${signal}`, "kill");
}

export function nodeProcessSignalError(
  result: Exclude<KernelResult<unknown>, { status: "ok" }>,
): NodeSystemError {
  if (result.status === "would_block") {
    return new NodeSystemError(
      "ENOTSUP",
      "Synchronous process.kill cannot wait for the host",
      "kill",
    );
  }
  const codes: Record<KernelErrorCode, NodeSystemError["code"]> = {
    ABI_MISMATCH: "ENOTSUP",
    ALREADY_EXISTS: "EIO",
    ALREADY_WAITING: "EAGAIN",
    CANCELLED: "ECANCELED",
    EXPIRED: "ESRCH",
    INVALID_ARGUMENT: "EINVAL",
    INVALID_HANDLE: "ESRCH",
    IO_ERROR: "EIO",
    NOT_FOUND: "ESRCH",
    PERMISSION_DENIED: "EPERM",
    RESOURCE_LIMIT: "EAGAIN",
    UNSUPPORTED: "ENOTSUP",
  };
  return new NodeSystemError(codes[result.error.code], result.error.message, "kill");
}
