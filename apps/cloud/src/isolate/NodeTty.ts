import { unsupportedNodeOperation } from "./node/process/NodeError.ts";

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
