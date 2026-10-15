import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { makeEngine, WorkflowEngine } from "../WorkflowEngine.ts";
import { HostedRuns, makeHostedDriver, type HostedRunsShape } from "./hostedDriver.ts";

/**
 * The engine on a durable workflow backend (`AutomationRunner`), with the
 * handlers the backend's instances call (`HostedRuns`).
 */
export const layer = Layer.effectContext(
  Effect.gen(function* () {
    let runs: HostedRunsShape | undefined;
    const engine = yield* makeEngine((core) =>
      makeHostedDriver(core).pipe(
        Effect.map((hosted) => {
          runs = hosted.runs;
          return hosted.driver;
        }),
      ),
    );
    if (runs === undefined) return yield* Effect.die("The hosted run core wasn't built.");
    return Context.make(WorkflowEngine, engine).pipe(Context.add(HostedRuns, runs));
  }),
);
