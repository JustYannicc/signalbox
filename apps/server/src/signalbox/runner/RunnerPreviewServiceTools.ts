import { PortSchema, TrimmedNonEmptyString } from "@t3tools/contracts";
import { PreviewServiceCwd } from "@signalbox/runner-protocol/PreviewServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { register, ToolError } from "./RunnerContextTools.ts";
import * as RunnerPreviewServiceCommands from "./RunnerPreviewServiceCommands.ts";

/** The agent's explicit way to make its dev server survive a new Runner. */
export const layerPreviewServiceTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const commands = yield* RunnerPreviewServiceCommands.RunnerPreviewServiceCommands;
    yield* Effect.all([
      register({
        name: "preview_service_start",
        description:
          "Start and declare a dev server on the supplied port. Pass the exact command the project uses; Signalbox will run it in a shell from cwd (relative to the thread's drive, default '.'). This declaration survives a new machine, so use this tool instead of leaving a background shell when the preview must remain available.",
        parameters: Schema.Struct({
          port: PortSchema,
          command: TrimmedNonEmptyString,
          cwd: Schema.optional(PreviewServiceCwd),
        }),
        writes: { destructive: false, openWorld: true },
        handle: ({ port, command, cwd }) =>
          commands.start({ port, command, cwd: cwd ?? "." }).pipe(
            Effect.mapError((error) => new ToolError({ message: error.message, cause: error })),
            Effect.as(`Preview service declared on port ${port}.`),
          ),
      }),
      register({
        name: "preview_service_stop",
        description:
          "Stop and undeclare the preview dev server on this port. The machine stops its process and Signalbox removes the declaration so it will not start on the next machine.",
        parameters: Schema.Struct({ port: PortSchema }),
        writes: { destructive: true, openWorld: true },
        handle: ({ port }) =>
          commands.stop(port).pipe(
            Effect.mapError((error) => new ToolError({ message: error.message, cause: error })),
            Effect.as(`Preview service stopped on port ${port}.`),
          ),
      }),
    ]);
  }),
);
