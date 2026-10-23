type ErrorCode =
  | "INVALID"
  | "MISSING"
  | "CONFLICT"
  | "STALE_CONTROL"
  | "STALE_PUBLISHER"
  | "OUT_OF_ORDER"
  | "INDETERMINATE"
  | "LIMIT"
  | "CORRUPT"
  | "STORAGE";

export class HarnessThreadSupervisorError extends Error {
  readonly _tag = "HarnessThreadSupervisorError";
  readonly code: ErrorCode;
  constructor(code: ErrorCode, options?: ErrorOptions) {
    super(`Harness thread supervisor: ${code}`, options);
    this.code = code;
  }
}

export const fail = (code: ErrorCode): never => {
  throw new HarnessThreadSupervisorError(code);
};
