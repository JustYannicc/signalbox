import type * as Effect from "effect/Effect";
import type { HarnessFilesStoreCommand, HarnessFilesStoreResult } from "./contracts.ts";
import type { HarnessFilesStoreError } from "./errors.ts";

export interface HarnessFilesDatabase {
  readonly sql: {
    exec(
      query: string,
      ...bindings: (string | number | null | ArrayBuffer)[]
    ): Iterable<Record<string, unknown>>;
  };
  transactionSync<A>(operation: () => A): A;
}

export interface HarnessFilesStore {
  readonly execute: (
    input: unknown,
  ) => Effect.Effect<HarnessFilesStoreResult, HarnessFilesStoreError>;
}

export type DecodedCommand = HarnessFilesStoreCommand;
