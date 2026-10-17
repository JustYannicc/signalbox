import { PortSchema, TrimmedNonEmptyString } from "@t3tools/contracts";
import { PreviewServiceCwd, type PreviewService } from "@signalbox/runner-protocol/PreviewServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { fail, register, ToolError } from "./RunnerContextTools.ts";
import type { RunnerPreviewServices } from "./RunnerPreviewServices.ts";

export const PREVIEW_SERVICE_TOOLS = ["preview_service_start", "preview_service_stop"] as const;

/** The agent's explicit way to make its dev server survive a new Runner. */
export const layerPreviewServiceTools = (
  services: RunnerPreviewServices,
  persist: (services: ReadonlyArray<PreviewService>) => Effect.Effect<void>,
) =>
  Layer.effectDiscard(
    Effect.all([
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
          Effect.gen(function* () {
            yield* services
              .start({ port, command, cwd: cwd ?? "." })
              .pipe(Effect.mapError((error) => new ToolError({ message: error.message })));
            yield* persist(yield* services.list);
            return `Preview service declared on port ${port}.`;
          }),
      }),
      register({
        name: "preview_service_stop",
        description:
          "Stop and undeclare the preview dev server on this port. The machine stops its process and Signalbox removes the declaration so it will not start on the next machine.",
        parameters: Schema.Struct({ port: PortSchema }),
        writes: { destructive: true, openWorld: true },
        handle: ({ port }) =>
          Effect.gen(function* () {
            if (!(yield* services.list).some((service) => service.port === port)) {
              return yield* fail(`No preview service is declared on port ${port}.`);
            }
            yield* services.stop(port);
            yield* persist(yield* services.list);
            return `Preview service stopped on port ${port}.`;
          }),
      }),
    ]),
  );
