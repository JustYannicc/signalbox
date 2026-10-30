import { markNodeBuiltinCapability } from "./NodeBuiltinCapabilities.ts";

export class NodeBuiltinUnsupportedError extends Error {
  readonly code = "ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED";
  readonly builtin: string;

  constructor(builtin: string) {
    super(`${builtin} is not implemented in the Signalbox Node runtime`);
    this.name = "NodeBuiltinUnsupportedError";
    this.builtin = builtin;
  }
}

export function createUnsupportedNodeBuiltin(builtin: string, evidence: string) {
  // A regular function also rejects construction of unavailable VM classes.
  return markNodeBuiltinCapability(
    function unsupportedNodeBuiltin(..._args: readonly unknown[]): never {
      throw new NodeBuiltinUnsupportedError(builtin);
    },
    {
      status: "unsupported",
      evidence,
      failure: { kind: "named-error", code: "ERR_SIGNALBOX_NODE_BUILTIN_UNSUPPORTED" },
    },
  );
}
