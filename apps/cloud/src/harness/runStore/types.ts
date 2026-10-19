import type * as Effect from "effect/Effect";
import type { HarnessRunStoreError } from "./errors.ts";
import type { HarnessRunStoreResult } from "./records.ts";

export interface HarnessRunDatabase {
  readonly sql: {
    exec(query: string, ...bindings: (string | number | null)[]): Iterable<Record<string, unknown>>;
  };
  transactionSync<A>(operation: () => A): A;
}

export interface HarnessRunStore {
  /** Internal binding only. Keep controlKey with the controller, give each supervisor only its claim key. */
  readonly execute: (
    command: unknown,
  ) => Effect.Effect<HarnessRunStoreResult, HarnessRunStoreError>;
}
