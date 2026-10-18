export type NodeSystemErrorCode =
  | "ECANCELED"
  | "EAGAIN"
  | "EIO"
  | "EINVAL"
  | "ENOTSUP"
  | "EPERM"
  | "ESRCH";

export class NodeSystemError extends Error {
  readonly code: NodeSystemErrorCode;
  readonly syscall: string | undefined;

  constructor(code: NodeSystemErrorCode, message: string, syscall?: string) {
    super(message);
    this.name = "NodeSystemError";
    this.code = code;
    this.syscall = syscall;
  }
}

export function unsupportedNodeOperation(syscall: string): never {
  throw new NodeSystemError("ENOTSUP", `${syscall} is unavailable in this host`, syscall);
}
