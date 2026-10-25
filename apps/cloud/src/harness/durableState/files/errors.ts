type ErrorCode =
  | "INVALID"
  | "MISSING"
  | "CONFLICT"
  | "STALE_CONTROL"
  | "STALE_PUBLISHER"
  | "OUT_OF_ORDER"
  | "LIMIT"
  | "CORRUPT"
  | "STORAGE";

export class HarnessFilesStoreError extends Error {
  readonly _tag = "HarnessFilesStoreError";
  readonly code: ErrorCode;
  constructor(code: ErrorCode, options?: ErrorOptions) {
    super(`Harness files store: ${code}`, options);
    this.code = code;
  }
}

export const fail = (code: ErrorCode): never => {
  throw new HarnessFilesStoreError(code);
};
