export interface FacetStorage {
  readonly sql: {
    exec(
      query: string,
      ...bindings: (string | number | null | ArrayBuffer)[]
    ): Iterable<Record<string, unknown>>;
    readonly databaseSize: number;
  };
  transactionSync<T>(callback: () => T): T;
}
export const firstRow = (
  rows: Iterable<Record<string, unknown>>,
): Record<string, unknown> | undefined => {
  const result = rows[Symbol.iterator]().next();
  return result.done ? undefined : result.value;
};
export class StorageError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "StorageError";
    this.code = code;
  }
}
export const MAX_FILE_SIZE = (1n << 63n) - 1n;
export const fileSize = (value: bigint) => {
  if (value < 0n) throw new StorageError("EINVAL");
  if (value > MAX_FILE_SIZE) throw new StorageError("EFBIG");
  return value;
};
