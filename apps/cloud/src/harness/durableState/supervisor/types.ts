import type * as Effect from "effect/Effect";
import type { HarnessThreadSupervisorError } from "./errors.ts";
import type { HarnessThreadSupervisorCommand, HarnessThreadSupervisorResult } from "./contracts.ts";

export interface HarnessThreadSupervisorDatabase {
  readonly sql: {
    exec(query: string, ...bindings: (string | number | null)[]): Iterable<Record<string, unknown>>;
  };
  transactionSync<A>(operation: () => A): A;
}

export interface HarnessThreadSupervisor {
  readonly execute: (
    input: unknown,
  ) => Effect.Effect<HarnessThreadSupervisorResult, HarnessThreadSupervisorError>;
}

export type DecodedCommand = HarnessThreadSupervisorCommand;
