export type NodeSystemErrorCode =
  | "ECANCELED"
  | "EAGAIN"
  | "EIO"
  | "EINVAL"
  | "ENOSYS"
  | "ENOTSUP"
  | "EPERM"
  | "ESRCH";

export class NodeSystemError extends Error {
  readonly code: NodeSystemErrorCode;
  readonly syscall: string | undefined;
  declare readonly path?: string;

  constructor(
    code: NodeSystemErrorCode,
    message: string,
    syscall?: string,
    options?: { readonly path?: string },
  ) {
    super(message);
    this.name = "NodeSystemError";
    this.code = code;
    this.syscall = syscall;
    if (options?.path !== undefined) this.path = options.path;
  }
}

export function unsupportedNodeOperation(syscall: string): never {
  throw new NodeSystemError("ENOTSUP", `${syscall} is unavailable in this host`, syscall);
}
