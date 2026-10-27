import { captureHarnessCProductFiles } from "../../HarnessCProductCheckpoint.ts";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HarnessError, type HarnessCheckpoint } from "../../Harness.ts";
import type { HarnessHostSession, HostOpenInput, TurnAccess } from "../../HarnessSessionHost.ts";
import type { ProductHarnessSessionHost, ProductHostOptions } from "../../HarnessCProductFacet.ts";
import type { HarnessReleaseArtifact } from "../../../harnessReleases/HarnessReleaseLedger.ts";
import type { HarnessProcessResumePreparedRelease } from "../../HarnessProcessResume.ts";
import { machineInventoryFixture } from "../../../computer/machineInventoryTesting.ts";

export type Grant = {
  readonly kind: "initial" | "turn";
  readonly requestId: string;
  readonly call: number;
};
export type Options = ProductHostOptions<Grant, unknown> & {
  readonly processResumeArtifact?: HarnessReleaseArtifact;
};
export type Host = ProductHarnessSessionHost<Grant> & {
  loadedPreparedRelease(): HarnessProcessResumePreparedRelease;
};

export function createRecordingHost(input: {
  readonly options: Options;
  readonly source: {
    readonly artifact: HarnessReleaseArtifact;
    readonly expected: HarnessProcessResumePreparedRelease;
  };
  readonly checkpoint: HarnessCheckpoint;
  readonly files: readonly {
    readonly path: string;
    readonly mode: number;
    readonly bytes: Uint8Array;
  }[];
  readonly observedTurnGrants: TurnAccess<Grant>[];
  readonly seeded: string[];
  readonly openInputs: HostOpenInput<Grant>[];
  readonly faults: { readonly failSeed?: "assets" | "programs" };
  readonly onDispose: () => void;
}) {
  const { options, source, checkpoint, files, observedTurnGrants, seeded, openInputs, faults } =
    input;
  return Effect.sync(() => {
    expect(options.processResumeArtifact).toBe(source.artifact);
    expect(options.machineInventory).toEqual(machineInventoryFixture());
    const session: HarnessHostSession<Grant> = {
      retireCheckpointAccess: Effect.void,
      release: checkpoint.release,
      providerSession: checkpoint.providerSession,
      events: Stream.never,
      turn: ({ access }) =>
        Effect.gen(function* () {
          observedTurnGrants.push(access);
          return yield* Effect.fail(
            new HarnessError({
              operation: "turn",
              message: "Unit fixture stops after recording turn access.",
            }),
          );
        }),
      control: () => Effect.void,
      export: () => Effect.succeed(checkpoint),
      dispose: Effect.void,
    };
    return {
      threadId: options.threadId,
      release: checkpoint.release,
      get computer(): Host["computer"] {
        throw new Error("Unit fixture does not expose Computer.");
      },
      get commands(): Host["commands"] {
        throw new Error("Unit fixture does not expose commands.");
      },
      seed: (stage) =>
        Effect.sync(() => {
          const captured = captureHarnessCProductFiles({
            files: options.files,
            threadId: options.threadId,
            paths: files.map((file) => file.path),
          });
          expect(captured).toEqual(files);
          seeded.push(stage);
        }).pipe(
          Effect.andThen(() =>
            stage === faults.failSeed
              ? Effect.fail(
                  new HarnessError({ operation: "open", message: "Injected seed failure." }),
                )
              : Effect.void,
          ),
        ),
      open: (input) =>
        Effect.sync(() => {
          expect(seeded).toEqual(["assets", "programs"]);
          openInputs.push(input);
          return session;
        }),
      dispose: Effect.sync(() => {
        input.onDispose();
      }),
      loadedPreparedRelease: () => source.expected,
    } satisfies Host;
  });
}
