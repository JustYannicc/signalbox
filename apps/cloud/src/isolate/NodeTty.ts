import { unsupportedNodeOperation } from "./node/process/NodeError.ts";
import { markNodeBuiltinCapability } from "./NodeBuiltinCapabilities.ts";

// Harness descriptors are kernel pipes and files. The personality has no terminal device.
export function isatty(_fd: unknown) {
  return false;
}

export function ReadStream(_fd: unknown): never {
  return unsupportedNodeOperation("tty.ReadStream");
}

export function WriteStream(_fd: unknown): never {
  return unsupportedNodeOperation("tty.WriteStream");
}

/** Plain own properties remain inspectable after bundling, unlike an ESM namespace's getters. */
export function createNodeTty() {
  markNodeBuiltinCapability(isatty, {
    status: "supported",
    evidence:
      "The harness exposes kernel pipes and files, with no terminal descriptors; isatty always returns false.",
  });
  for (const callable of [ReadStream, WriteStream]) {
    markNodeBuiltinCapability(callable, {
      status: "unsupported",
      evidence: "The harness has no terminal device; constructing a TTY stream throws ENOTSUP.",
      failure: { kind: "named-error", code: "ENOTSUP" },
    });
  }
  return Object.freeze({ isatty, ReadStream, WriteStream });
}
