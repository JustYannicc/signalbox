type ErrorCode =
  | "INVALID"
  | "MISSING"
  | "CONFLICT"
  | "STALE_SUPERVISOR"
  | "PUBLISHER_DENIED"
  | "OUT_OF_ORDER"
  | "TERMINAL"
  | "LIMIT"
  | "CORRUPT"
  | "STORAGE";
export class HarnessRunStoreError extends Error {
  readonly _tag = "HarnessRunStoreError";
  readonly code: ErrorCode;
  constructor(code: ErrorCode, options?: ErrorOptions) {
    super(`Harness run store: ${code}`, options);
    this.code = code;
  }
}

export const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);
export const fail = (code: HarnessRunStoreError["code"]): never => {
  throw new HarnessRunStoreError(code);
};
