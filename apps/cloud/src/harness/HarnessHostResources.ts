import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { ComputerBindings } from "../computer/OpenComputer.ts";
import type { Computer } from "../computer/Computer.ts";
import type { FacetStorage } from "../kernel/FacetSqliteStorage.ts";
import { createBootState } from "./host/boot.ts";
import { createHostStorage } from "./host/storage.ts";
import type { SeedCatalog } from "./host/seed.ts";
import type { HarnessHostOptions, SeedStage } from "./host/contracts.ts";
import { HarnessError } from "./Harness.ts";

export interface HarnessHostResources<Files = Computer["files"]> {
  readonly database: FacetStorage;
  readonly fileIdentity: Files;
  readonly boot: {
    check(): void;
    seed(stage: SeedStage, signal: AbortSignal): Promise<void>;
    claim(attemptId: string, inputHash: string, signal: AbortSignal): Promise<void>;
  };
  readonly bindComputer: (
    signal: AbortSignal,
  ) => Effect.Effect<Omit<ComputerBindings<Files>, "files">, HarnessError, Scope.Scope>;
}

/** The host coordinates resource operations; the adapter decides which owner holds the kernel. */
export const localHarnessHostResources = <G>(
  options: Pick<HarnessHostOptions<G>, "files" | "threadId" | "bindComputer">,
  catalog: SeedCatalog,
): Effect.Effect<HarnessHostResources, HarnessError, Scope.Scope> =>
  Effect.gen(function* () {
    const storage = yield* Effect.acquireRelease(
      Effect.try({
        try: () => createHostStorage(options.files, options.threadId),
        catch: (cause) =>
          new HarnessError({
            operation: "open",
            message: "Canonical Harness storage could not be opened.",
            cause,
          }),
      }),
      (value) =>
        Effect.sync(() => value.dispose()).pipe(
          Effect.catchCause((cause) =>
            Effect.die(
              new HarnessError({
                operation: "dispose",
                message: "Harness files cleanup failed.",
                cause,
              }),
            ),
          ),
        ),
    );
    return {
      database: storage.database,
      fileIdentity: storage.files,
      boot: createBootState(storage, catalog, options.threadId),
      bindComputer: (signal) =>
        options.bindComputer({
          threadId: options.threadId,
          files: storage.files,
          persistence: storage.persistence,
          signal,
        }),
    };
  });
